import { AccountUpdate, Experimental, fetchAccount, Field, Mina, PrivateKey, PublicKey, UInt64 } from 'o1js';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { Name, NameRecord, NameService, offchainState } from './NameService.js';

let sender: {address: PublicKey, key: PrivateKey};
let nameService: NameService;
let addresses: Record<string, PublicKey>;
let keys: Record<string, PrivateKey>;

describe('NameService', () => {
    beforeAll(async () => {
        const Local = await Mina.LocalBlockchain({proofsEnabled: false});
        Mina.setActiveInstance(Local);
        sender = {address: Local.testAccounts[0].key.toPublicKey(), key: Local.testAccounts[0].key};

        const {keys: _keys, addresses: _addresses } = randomAccounts('contract', 'user1', 'user2');
        keys = _keys;
        addresses = _addresses;
        nameService = new NameService(addresses.contract);
        offchainState.setContractInstance(nameService);
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
            const stringName = 'o1Labs001';
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

    describe('#set_record', () => {
        it('updates the record for a name', async () => {
            const stringName = 'o1Labs002';
            const stringUrl = 'o1Labs.org';
            const name = Name.fromString(stringName);
            const nr = new NameRecord({
                mina_address: addresses.user1,
                avatar: Field(0),
                url: Name.fromString(stringUrl).packed
            });

            await registerName(name, nr, nameService, sender);

            const newUrl = 'o1Labs.com';
            const newNr = new NameRecord({
                mina_address: addresses.user1,
                avatar: Field(0),
                url: Name.fromString(newUrl).packed
            });

            const setRecordTx = await Mina.transaction({sender: addresses.user1, fee: 1e5}, async () => {
                await nameService.set_record(name.packed, newNr);
            });
            setRecordTx.sign([keys.user1]);
            await setRecordTx.prove();
            await setRecordTx.send().wait();


            let resolved = await nameService.resolve_name(name.packed);
            expect(new Name(resolved.url).toString()).not.toEqual(newUrl);
            await settle(nameService, sender);
            resolved = await nameService.resolve_name(name.packed);
            expect(new Name(resolved.url).toString()).toEqual(newUrl);
        });
    });

    describe('#transfer_name_ownership', () => {
        let name: Name;
        let nr: NameRecord;
        
        it('transfers name ownership for a name it controls', async () => {
            const stringName = 'o1Labs003';
            const stringUrl = 'o1Labs.org';
            name = Name.fromString(stringName);
            nr = new NameRecord({
                mina_address: addresses.user1,
                avatar: Field(0),
                url: Name.fromString(stringUrl).packed
            });
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
            const stringName = 'o1Labs004';
            const stringUrl = 'o1Labs.org';
            name = Name.fromString(stringName);
            nr = new NameRecord({
                mina_address: addresses.user1,
                avatar: Field(0),
                url: Name.fromString(stringUrl).packed
            });
            await registerName(name, nr, nameService, sender);

            await expect((Mina.transaction({sender: addresses.user2, fee: 1e5}, async () => {
                await nameService.transfer_name_ownership(name.packed, addresses.user1);
            }))).rejects.toThrow();
        });

        it('fails to transfer a name that it owns but has not yet bees settled', async () => {
            const stringName = 'o1Labs005';
            const stringUrl = 'o1Labs.org';
            name = Name.fromString(stringName);
            nr = new NameRecord({
                mina_address: addresses.user1,
                avatar: Field(0),
                url: Name.fromString(stringUrl).packed
            });
            const registerTx = await Mina.transaction({sender: sender.address, fee: 1e5}, async () => {
                await nameService.register_name(name.packed, nr); // nr 1 is associated with user1
            });
            registerTx.sign([sender.key]);
            await registerTx.prove();
            await registerTx.send().wait();

            await expect(Mina.transaction({sender: addresses.user1, fee: 1e5}, async () => {
                await nameService.transfer_name_ownership(name.packed, addresses.user2); // user1 tries to transfer name to user2
            })).rejects.toThrow();

            await settle(nameService, sender);

            const transferTx = await Mina.transaction({sender: addresses.user1, fee: 1e5}, async () => {
                await nameService.transfer_name_ownership(name.packed, addresses.user2);
            });
            transferTx.sign([keys.user1]);
            await transferTx.prove();
            await transferTx.send().wait();

            expect(true); // after settling, the transfer succeeded
        });
    });


    describe('#owner_of', () => {
        it('returns the owner of a name', async () => {
            const stringName = 'o1Labs006';
            const name = Name.fromString(stringName);
            const nr = new NameRecord({
                mina_address: addresses.user1,
                avatar: Field(0),
                url: Field(0)
            });

            await expect(nameService.owner_of(name.packed)).rejects.toThrow();
            await registerName(name, nr, nameService, sender);
            expect((await nameService.owner_of(name.packed)).toBase58()).toEqual(addresses.user1.toBase58());
        });
    });

    describe('#resolve_name', () => {
        it('returns the full record associated with a name', async () => {
            const stringName = 'o1Labs007';
            const stringUrl = 'o1Labs.org';
            const name = Name.fromString(stringName);
            const nr = new NameRecord({
                mina_address: addresses.user1,
                avatar: Field(0),
                url: Name.fromString(stringUrl).packed
            });

            await registerName(name, nr, nameService, sender);
            const resolved = await nameService.resolve_name(name.packed);
            expect(resolved.toJSON()).toEqual(nr.toJSON());
        });
    });

    describe('#settle (with multiple transactions)', () => {
        it('registers multiple names from different users', async () => {
            const name1 = Name.fromString('o1Labs008');
            const nr1 = new NameRecord({
                mina_address: addresses.user1,
                avatar: Field(0),
                url: Name.fromString('o1Labs.org').packed
            });

            const name2 = Name.fromString('o1Labs2001');
            const nr2 = new NameRecord({
                mina_address: addresses.user2,
                avatar: Field(0),
                url: Name.fromString('o1Labs2.org').packed
            });

            const registerTx1 = await Mina.transaction({sender: addresses.user1, fee: 1e5}, async () => {
                await nameService.register_name(name1.packed, nr1);
            });
            registerTx1.sign([keys.user1]);
            await registerTx1.prove();
            await registerTx1.send().wait();

            const registerTx2 = await Mina.transaction({sender: addresses.user2, fee: 1e5}, async () => {
                await nameService.register_name(name2.packed, nr2);
            });
            registerTx2.sign([keys.user2]);
            await registerTx2.prove();
            await registerTx2.send().wait();

            await settle(nameService, sender);

            const resolved1 = await nameService.resolve_name(name1.packed);
            expect(resolved1.toJSON()).toEqual(nr1.toJSON());

            const resolved2 = await nameService.resolve_name(name2.packed);
            expect(resolved2.toJSON()).toEqual(nr2.toJSON());
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
    /**
     * Currently this test setup runs once before all tests.
     * Ideally it would run before each test to create a fresh instance of all artifacts.
     * Since `offchainState` is a singleton instance deeply integrated with the contract,
     * we cannot deploy different instances of the contract with different offchain states
     * to test.
     * 
     * TODO: Decouple instances of `offchainState` from the compiled circuit.
     * 
     */

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
    const settlementProof = await offchainState.createSettlementProof();

    const settleTx = await Mina.transaction({sender: sender.address, fee: 1e5}, async () => {
        await nameService.settle(settlementProof);
    });
    settleTx.sign([sender.key]);
    await settleTx.prove();
    await settleTx.send().wait();
}
