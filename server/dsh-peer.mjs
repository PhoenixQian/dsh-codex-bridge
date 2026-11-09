/** Legacy two-turn isolated peers are not a community runtime capability. */
export class DshPeer {
  constructor() { this.threadId = null; }
  async start() { throw Object.assign(new Error('Legacy DSH peers are unsupported. Connect the supported DSH Desktop Host and create a new Tongzhou discussion.'), { code: 'DSH_LEGACY_UNSUPPORTED' }); }
  async reply() { return this.start(); }
  async close() {}
}
