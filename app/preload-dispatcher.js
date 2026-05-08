const { setGlobalDispatcher, Agent } = require('undici');

const limit = parseInt(process.env.UNDICI_LIMIT || '1', 10);
setGlobalDispatcher(new Agent({ connections: limit }));
console.log(`[PRELOAD pid=${process.pid}] setGlobalDispatcher connections=${limit}`);
