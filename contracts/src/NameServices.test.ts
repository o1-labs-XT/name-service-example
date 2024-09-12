import { AccountUpdate, Field, Mina, PrivateKey, PublicKey, UInt64 } from 'o1js';
// import { beforeAll, beforeEach, describe, it } from 'vitest';
import { Name, NameRecord, NameService, offchainState } from './NameService.js';

describe('NameService', () => {
    let sender: {address: PublicKey, key: PrivateKey};
    const {keys, addresses } = randomAccounts('contract', 'user1', 'user2');
    const contract = { key: keys.contract, address: addresses.contract };
    const user1 = { key: keys.user1, address: addresses.user1 };
    const user2 = { key: keys.user2, address: addresses.user2 };
    const nameService = new NameService(contract.address);
    
    beforeAll(async () => {
        const Local = await Mina.LocalBlockchain({proofsEnabled: false});
        Mina.setActiveInstance(Local);
        sender = {address: Local.testAccounts[0].key.toPublicKey(), key: Local.testAccounts[0].key};
    });

    beforeEach(async () => {
        await testSetup(nameService, sender, addresses, keys);
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
    const deployTx = await Mina.transaction({sender: sender.address, fee: 1e5}, async () => {
        AccountUpdate.fundNewAccount(sender.address);
        nameService.deploy();
        nameService.init();
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

    offchainState.setContractInstance(nameService);
    
    const initTx = await Mina.transaction({sender: sender.address, fee: 1e9}, async () => {
        await nameService.set_premium(UInt64.from(10));
    });
    await initTx.prove();
    initTx.sign([sender.key]);
    await initTx.send().wait();

    await settle(nameService, sender);
}

async function settle(nameService: NameService, sender: {address: PublicKey, key: PrivateKey}) {
    const premiumSettlementProof = await offchainState.createSettlementProof();

    const settleTx = await Mina.transaction({sender: sender.address, fee: 1e5}, async () => {
        await nameService.settle(premiumSettlementProof);
    });
    settleTx.sign([sender.key]);
    await settleTx.prove();
    await settleTx.send().wait();
}