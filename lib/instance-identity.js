import { instanceFingerprint } from '../server/runtime-config.mjs';

const ENDPOINT = 'tongzhou.bridgeIdentity';
const BUILD_ID = 'tongzhou-community-0.3.0';

/**
 * Exact native Connection Fetch route, behind DSH's owner-Peer fence.
 * The browser uses connection.rpc.call('/api', ENDPOINT, {}), so preserve the
 * documented generic RPC envelope. No key, filesystem path or supplied identity
 * is accepted or returned. DATA_ROOT and CODE_ROOT come from this Host process.
 */
export function createIdentityRoute() {
  const identity = Object.freeze({buildId: BUILD_ID, instanceId: instanceFingerprint()});
  return {
    path: `/api/${ENDPOINT}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let message;
      try { message = await request.json(); } catch { return new Response('Invalid identity request.', {status:400}); }
      if (!message || typeof message !== 'object' || Array.isArray(message) ||
          Object.keys(message).some(key => !['type','rpcId','method','payload'].includes(key)) ||
          message.type !== 'client-request' || message.method !== ENDPOINT ||
          typeof message.rpcId !== 'string' || !message.rpcId || message.rpcId.length > 128 ||
          !message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload) || Object.keys(message.payload).length) {
        return new Response('Invalid identity request.', {status:400});
      }
      return Response.json({type:'server-response',rpcId:message.rpcId,result:{ok:true,value:identity}}, {
        headers:{'cache-control':'no-store'}
      });
    }
  };
}
