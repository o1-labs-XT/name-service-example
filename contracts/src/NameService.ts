import {
  Mina,
  NetworkId,
  PrivateKey,
  Field,
  SmartContract,
  state,
  State,
  method,
  Experimental,
  Struct,
  PublicKey,
  Bool,
  UInt64,
  AccountUpdate,
  
} from 'o1js';
import { PackedStringFactory } from './o1js-pack/PackedString.js';

export { NameService, NameRecord, StateProof, Name, Mina, offchainState, type NameServiceOffchainState, NetworkId, PrivateKey, Experimental, Field, UInt64 };
const { OffchainState, OffchainStateCommitments} = Experimental;

class Name extends PackedStringFactory(31) {}
class NameRecord extends Struct({
  mina_address: PublicKey,
  avatar: Field,
  url: Field,
}) {
  empty(): NameRecord {
    return new NameRecord({
      mina_address: PublicKey.empty(),
      avatar: Field(0),
      url: Field(0),
    });
  }

  toJSON(): string {
    return JSON.stringify({
      mina_address: this.mina_address.toBase58(),
      avatar: this.avatar.toString(),
      url: this.url.toString(),
    });
  }
}

class PauseToggleEvent extends Struct({ was_paused: Bool, is_paused: Bool }) {}
class AdminChangedEvent extends Struct({
  old_admin: PublicKey,
  new_admin: PublicKey,
}) {}

const offchainState = OffchainState(
  {
    registry: OffchainState.Map(Field, NameRecord),
    premium: OffchainState.Field(UInt64),
  },
  { logTotalCapacity: 10, maxActionsPerProof: 5 }
);

type NameServiceOffchainState = typeof offchainState;


class StateProof extends offchainState.Proof {}

class NameService extends SmartContract {
  @state(OffchainState.Commitments) offchainState = offchainState.commitments();
  @state(PublicKey) admin = State<PublicKey>();
  @state(Bool) paused = State<Bool>();

  events = {
    pause_toggle_event: PauseToggleEvent,
    admin_changed_event: AdminChangedEvent,
  };

  init() {
    super.init();
    this.admin.set(this.sender.getAndRequireSignature());
  }

  async setOffchainState(offchainState: NameServiceOffchainState) {
  }

  /**
   * Settles settlement proof
   *
   * @param proof - StateProof generated by the Offchain State ZkProgram
   */
  @method
  async settle(proof: StateProof) {
    await offchainState.settle(proof);
  }

  /**
   * Sender transfers {this.premium_rate()} to the contract and emits an action that sets themselves as the owner of the name in the offchain state.
   * This state change is applied when the emitted actions are settled.
   *
   * Fails if
   *   - sender cannot afford premium
   *   - name is already owned
   *
   * @param name
   * @param record
   *
   */
  @method async register_name(name: Field, record: NameRecord) {
    (await offchainState.fields.registry.get(name)).isSome.assertFalse(); // do we need this?
    let premium = await this.premium_rate();
    const sender = this.sender.getAndRequireSignature();
    const payment_update = AccountUpdate.createSigned(sender);
    payment_update.send({ to: this.address, amount: premium });
    offchainState.fields.registry.update(name, {
      from: undefined,
      to: record,
    });
  }

  /**
   * Sets the domain record for a given name
   * Fails if
   *   - the name is not registered
   *   - the name is not owned by sender
   *
   * @param name
   * @param new_record
   *
   */
  @method async set_record(name: Field, new_record: NameRecord) {
    let current_record = (
      await offchainState.fields.registry.get(name)
    ).assertSome('this name is not owned');
    const sender = this.sender.getAndRequireSignature();
    current_record.mina_address.assertEquals(sender);
    offchainState.fields.registry.update(name, {
      from: current_record,
      to: new_record,
    });
  }

  /**
   * Transfer ownerhsip of a name record to a new PublicKey
   * Fails if
   *   - the name is not registered
   *   - the name is not owned by sender
   *
   * @param name
   * @param new_owner
   *
   */
  @method async transfer_name_ownership(name: Field, new_owner: PublicKey) {
    let current_record = (
      await offchainState.fields.registry.get(name)
    ).assertSome('this name is not owned');
    const sender = this.sender.getAndRequireSignature();
    current_record.mina_address.assertEquals(sender);
    let new_record = new NameRecord({
      mina_address: new_owner,
      avatar: current_record.avatar,
      url: current_record.url,
    });
    offchainState.fields.registry.update(name, {
      from: current_record,
      to: new_record,
    });
  }

  /**
   * @param name
   * @returns owner of given name
   */
  @method.returns(PublicKey) async owner_of(name: Field) {
    return (await offchainState.fields.registry.get(name)).assertSome(
      'this name is not owned'
    ).mina_address;
  }

  /**
   * @param name
   * @returns full record associated with given name
   */
  @method.returns(NameRecord) async resolve_name(name: Field) {
    return (await offchainState.fields.registry.get(name)).assertSome(
      'this name is not owned'
    );
  }

  /**
   * @returns the current premium required to register a new name
   */
  @method.returns(UInt64) async premium_rate() {
    return (await offchainState.fields.premium.get()).assertSome(
      'premium is not initialized'
    );
  }

  /**
   * @returns the public key of the admin
   */
  @method.returns(PublicKey) async get_admin() {
    return this.admin.getAndRequireEquals();
  }

  /**
   * @returns true if the contract is currently paused, false otherwise
   */
  @method.returns(Bool) async is_paused() {
    return this.paused.getAndRequireEquals();
  }

  // ADMIN FUNCTIONS

  /**
   * Set the premium required to register a new name
   * Fails if sender is not admin
   *
   * @param new_premimum
   *
   * @emits PremiumChangedEvent
   */
  @method async set_premium(new_premimum: UInt64) {
    let current_premium = await offchainState.fields.premium.get();
    offchainState.fields.premium.update({
      from: current_premium,
      to: new_premimum,
    });
  }

  /**
   * Change the pause state of the smart contract, pausing it if currently unpaused or unpausing it if currently paused
   * Fails if sender is not admin
   *
   * @emits PauseToggleEvent
   */
  @method async toggle_pause() {
    let current_admin = this.admin.getAndRequireEquals();
    const sender = this.sender.getAndRequireSignature();
    current_admin.assertEquals(sender);
    let is_paused = this.paused.getAndRequireEquals();
    this.paused.set(is_paused.not());

    this.emitEvent('pause_toggle_event', {
      was_paused: is_paused,
      is_paused: is_paused.not(),
    });
  }

  /**
   * Set a new admin
   * Fails if sender is not admin
   *
   * @param new_admin
   * @emits AdminChangeEvent
   */
  @method async change_admin(new_admin: PublicKey) {
    let current_admin = this.admin.getAndRequireEquals();
    const sender = this.sender.getAndRequireSignature();
    current_admin.assertEquals(sender);
    this.admin.set(new_admin);

    this.emitEvent('admin_changed_event', {
      old_admin: current_admin,
      new_admin: new_admin,
    });
  }
}
