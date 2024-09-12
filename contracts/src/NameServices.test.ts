import { AccountUpdate, Experimental, fetchAccount, Field, Mina, PrivateKey, PublicKey, UInt64 } from 'o1js';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { createOffChainState, Name, NameRecord, NameService } from './NameService.js';

let sender: {address: PublicKey, key: PrivateKey};
let nameService: NameService;
let addresses: Record<string, PublicKey>;
let keys: Record<string, PrivateKey>;

describe('NameService', () => {
    beforeAll(async () => {
        const Local = await Mina.LocalBlockchain({proofsEnabled: false});
        Mina.setActiveInstance(Local);
        sender = {address: Local.testAccounts[0].key.toPublicKey(), key: Local.testAccounts[0].key};
    });

    beforeEach(async () => {
        const {keys: _keys, addresses: _addresses } = randomAccounts('contract', 'user1', 'user2');
        keys = _keys;
        addresses = _addresses;
        nameService = new NameService(addresses.contract);
        await testSetup(nameService, sender, addresses, keys);
    });

    describe('#set_premium', () => {
        it('updates the premium', async () => {
            const newPremium = UInt64.from(5);
            const setPremiumTx = await Mina.transaction({sender: sender.address, fee: 1e5}, async () => {
                await nameService.set_premium(newPremium);
            });
            setPremiumTx.sign([sender.key]);
            await setPremiumTx.prove();
            await setPremiumTx.send().wait();

            expect((await nameService.premium_rate()).toString()).not.toEqual('5'); // ensure the premium didn't happen to be 5 before settlement
            await settle(nameService, sender);
            expect((await nameService.premium_rate()).toString()).toEqual('5');
        });
    });

    describe('#register_name', () => {
        it('registers a name', async () => {
            const stringName = 'o1Labs';
            const stringUrl = 'o1Labs.org';
            const name = Name.fromString(stringName);
            const nr = new NameRecord({
                mina_address: addresses.user1,
                avatar: Field(0),
                url: Name.fromString(stringUrl).packed
            });

            const registerTx = await Mina.transaction({sender: addresses.user1, fee: 1e5}, async () => {
                await nameService.register_name(name.packed, nr);
            });
            registerTx.sign([keys.user1]);
            await registerTx.prove();
            await registerTx.send().wait();

            await expect(nameService.resolve_name(name.packed)).rejects.toThrow(); // Name should not be registered before settlement
            await settle(nameService, sender);
            expect((await nameService.resolve_name(name.packed)).mina_address.toBase58()).toEqual(addresses.user1.toBase58());

            const registeredUrl = new Name((await nameService.resolve_name(name.packed)).url).toString();
            expect(registeredUrl).toEqual(stringUrl);
        });
    });

    describe('#transfer_name_ownership', () => {
        let name: Name;
        let nr: NameRecord;

        beforeEach(async () => {
            const stringName = 'o1Labs';
            const stringUrl = 'o1Labs.org';
            name = Name.fromString(stringName);
            nr = new NameRecord({
                mina_address: addresses.user1,
                avatar: Field(0),
                url: Name.fromString(stringUrl).packed
            });
        });
        
        it('transfers name ownership for a name it controls', async () => {
            await registerName(name, nr, nameService, sender);

            const transferTx = await Mina.transaction({sender: addresses.user1, fee: 1e5}, async () => {
                await nameService.transfer_name_ownership(name.packed, addresses.user2);
            });
            transferTx.sign([keys.user1]);
            await transferTx.prove();
            await transferTx.send().wait();

            await settle(nameService, sender);
            expect((await nameService.resolve_name(name.packed)).mina_address.toBase58()).toEqual(addresses.user2.toBase58());
        });

        it('fails to transfer name ownership for a name it does not control', async () => {
            await registerName(name, nr, nameService, sender);

            await expect((Mina.transaction({sender: addresses.user2, fee: 1e5}, async () => {
                await nameService.transfer_name_ownership(name.packed, addresses.user1);
            }))).rejects.toThrow();
        });
    });
});

function randomAccounts<K extends string>(
    ...names: [K, ...K[]]
  ): { keys: Record<K, PrivateKey>; addresses: Record<K, PublicKey> } {
    let base58Keys = Array(names.length)
      .fill('')
      .map(() => PrivateKey.random().toBase58());
    let keys = Object.fromEntries(
      names.map((name, idx) => [name, PrivateKey.fromBase58(base58Keys[idx])])
    ) as Record<K, PrivateKey>;
    let addresses = Object.fromEntries(
      names.map((name) => [name, keys[name].toPublicKey()])
    ) as Record<K, PublicKey>;
    return { keys, addresses };
  }
  
async function testSetup(nameService: NameService, sender: {address: PublicKey, key: PrivateKey}, addresses: Record<string, PublicKey>, keys: Record<string, PrivateKey>) {
    const offchainState = createOffChainState();
    offchainState.setContractInstance(nameService);
    const deployTx = await Mina.transaction({sender: sender.address, fee: 1e5}, async () => {
        AccountUpdate.fundNewAccount(sender.address);
        nameService.deploy();
        nameService.init();
        nameService.setOffchainState(offchainState);
    });
    await deployTx.prove();
    deployTx.sign([sender.key, keys.contract]);
    await deployTx.send().wait();

    const fundTx = await Mina.transaction({sender: sender.address, fee: 1e5}, async () => {
        const au = AccountUpdate.fundNewAccount(sender.address, 2);
        au.send({to: addresses.user1, amount: 1e9});
        au.send({to: addresses.user2, amount: 1e9});
    });
    fundTx.sign([sender.key]);
    await fundTx.send().wait();

    
    const initTx = await Mina.transaction({sender: sender.address, fee: 1e9}, async () => {
        await nameService.set_premium(UInt64.from(10));
    });
    await initTx.prove();
    initTx.sign([sender.key]);
    await initTx.send().wait();

    await settle(nameService, sender);
}

async function registerName(name: Name, nr: NameRecord, nameService: NameService, sender: {address: PublicKey, key: PrivateKey}) {
    const registerTx = await Mina.transaction({sender: sender.address, fee: 1e5}, async () => {
        await nameService.register_name(name.packed, nr);
    });
    registerTx.sign([sender.key]);
    await registerTx.prove();
    await registerTx.send().wait();

    await settle(nameService, sender);
}

async function settle(nameService: NameService, sender: {address: PublicKey, key: PrivateKey}) {
    const settlementProof = await nameService.localOffchainState.createSettlementProof();

    const settleTx = await Mina.transaction({sender: sender.address, fee: 1e5}, async () => {
        await nameService.settle(settlementProof);
    });
    settleTx.sign([sender.key]);
    await settleTx.prove();
    await settleTx.send().wait();
}
