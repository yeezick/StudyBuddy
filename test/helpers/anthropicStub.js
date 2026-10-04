// Offline Anthropic stub. The SDK captures fetch when the client is built (at import), so call
// stubAnthropic() before the app modules load.
//
// Tests queue JSON replies in order. A question-generation call ("Generate N questions") takes
// the next N questions from the first queued array, so one queued array serves a quiz whose Q1
// and remaining questions are written by separate calls. Any other call takes the first queued
// non-array reply. A function or an Error at the head of the queue answers the next call,
// whatever it is: the function is called with the request body; an Error (also one a function
// returns) answers with HTTP 400, which the SDK does not retry; a Response a function returns is
// sent as-is. A streamed request gets its reply as server-sent events. Nothing queued throws, which the SDK sees as a connection error.
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A streamed reply (server-sent events) whose text arrives in `chunks`; a chunk may be a promise,
// so a test can hold the stream open part-way.
export function sseResponse(chunks) {
  const enc = new TextEncoder();
  const event = (type, data) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(event('message_start', { message: {
        id: 'msg_test', type: 'message', role: 'assistant', model: 'test-model', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
      } }));
      controller.enqueue(event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
      for (const chunk of chunks) {
        controller.enqueue(event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: await chunk } }));
      }
      controller.enqueue(event('content_block_stop', { index: 0 }));
      controller.enqueue(event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }));
      controller.enqueue(event('message_stop', {}));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function stubAnthropic() {
  const replies = [];
  const requests = [];
  const realFetch = globalThis.fetch;

  const take = (body) => {
    const user = body.messages?.[0]?.content ?? '';
    const n = /^Generate (\d+) questions/.exec(typeof user === 'string' ? user : '')?.[1];
    if (n) {
      const i = replies.findIndex(Array.isArray);
      if (i < 0) throw new Error('test: unexpected question generation call');
      const batch = replies[i].splice(0, Number(n));
      if (replies[i].length === 0) replies.splice(i, 1);
      return batch;
    }
    const i = replies.findIndex((r) => !Array.isArray(r));
    if (i < 0) throw new Error('test: unexpected Anthropic call');
    return replies.splice(i, 1)[0];
  };

  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.anthropic.com')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    requests.push(body);
    let reply;
    if (typeof replies[0] === 'function') reply = await replies.shift()(body, init);
    else if (replies[0] instanceof Error) reply = replies.shift();
    else reply = take(body);
    if (reply instanceof Response) return reply;
    if (reply instanceof Error) return json(400, { type: 'error', error: { type: 'invalid_request_error', message: reply.message } });
    const text = JSON.stringify(reply);
    // A streamed request gets the same reply as events, in two chunks.
    if (body.stream) return sseResponse([text.slice(0, text.length >> 1), text.slice(text.length >> 1)]);
    return json(200, {
      id: 'msg_test', type: 'message', role: 'assistant', model: 'test-model',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    });
  };

  return { replies, requests };
}
