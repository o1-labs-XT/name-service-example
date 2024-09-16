import { AccountUpdate, Experimental, fetchAccount, Field, Mina, PrivateKey, PublicKey, UInt64 } from 'o1js';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { createOffChainState, Name, NameRecord, offchainState, NameService, type NameServiceOffchainState } from './NameService.js';

const { OffchainState, OffchainStateCommitments} = Experimental;

let sender: {address: PublicKey, key: PrivateKey};
let nameService: NameService;
let addresses: Record<string, PublicKey>;
let keys: Record<string, PrivateKey>;

describe('NameService', () => {
    beforeAll(async () => {
        const Local = await Mina.LocalBlockchain({proofsEnabled: true});
        const {keys: _keys, addresses: _addresses } = randomAccounts('contract', 'user1', 'user2');
        Mina.setActiveInstance(Local);
        sender = {address: Local.testAccounts[0].key.toPublicKey(), key: Local.testAccounts[0].key};
        keys = _keys;
        addresses = _addresses;
        await offchainState.compile();
        offchainState.setContractClass(NameService);
        await NameService.compile();
        console.log('compiled');
        nameService = new NameService(addresses.contract);
        await testSetup(nameService, sender, addresses, keys);
    });

    describe('provable integration test', () => {
        it('registers names, transfers names, updates records, and resolves names', async () => {
            /**
             * Generate and register two names, name1 and name2, with NameRecords nr1 and nr2.
             */
            const name1 = Name.fromString('name1');
            const name2 = Name.fromString('name2');

            const nr1 = new NameRecord({mina_address: addresses.user1, avatar: Field(1), url: Field(1)});
            const nr2 = new NameRecord({mina_address: addresses.user2, avatar: Field(2), url: Field(2)});

            await registerName(name1, nr1, nameService, sender);
            await registerName(name2, nr2, nameService, sender);

            await settle(nameService, sender);
            const name1Record = await nameService.resolve_name(name1.packed);
            expect(name1Record.toJSON()).toEqual(nr1.toJSON());
            const name2Record = await nameService.resolve_name(name2.packed);
            expect(name2Record.toJSON()).toEqual(nr2.toJSON());


            /**
             * Transfer name1 to user2 and update name2 to nr1.
             */
            const transferTx = await Mina.transaction({sender: addresses.user1, fee: 1e5}, async () => {
                await nameService.transfer_name_ownership(name1.packed, addresses.user2);
            });
            transferTx.sign([keys.user1]);
            await transferTx.prove();
            await transferTx.send().wait();

            await settle(nameService, sender);
            const name1RecordAfterTransfer = await nameService.resolve_name(name1.packed);
            expect(name1RecordAfterTransfer.toJSON()).toEqual(nr2.toJSON());


            /**
             * Update record at name2
             */
            const newNr2 = new NameRecord({mina_address: addresses.user2, avatar: Field(42), url: Field(100)});
            const updateTx = await Mina.transaction({sender: addresses.user2, fee: 1e5}, async () => {
                await nameService.set_record(name2.packed, newNr2);
            });
            updateTx.sign([keys.user2]);
            await updateTx.prove();
            await updateTx.send().wait();

            await settle(nameService, sender);
            const name2RecordAfterUpdate = await nameService.resolve_name(name2.packed);
            expect(name2RecordAfterUpdate.toJSON()).toEqual(newNr2.toJSON());
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
