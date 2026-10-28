import { http, HttpResponse } from 'msw';
import { setupWorker } from 'msw/browser';

const worker = setupWorker(
  http.get('/api/jux-msw/:name', ({ params }) =>
    HttpResponse.json(
      { name: `Mocked ${params.name}` },
      { headers: { 'x-jux-msw': 'intercepted' } },
    ),
  ),
);
let ready;

export default {
  title: 'Msw',
  loaders: [
    async ({ args }) => {
      // Await activation before the app request, as real Storybook loaders do.
      ready ??= worker.start({ quiet: true, onUnhandledRequest: 'bypass' });
      await ready;
      const response = await fetch(`/api/jux-msw/${args.name}`);
      if (response.headers.get('x-jux-msw') !== 'intercepted')
        throw new Error('MSW did not intercept the fixture request');
      return { account: await response.json() };
    },
  ],
  render: (_args, { loaded }) => (
    <main style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1>{loaded.account.name}</h1>
      <p>Rendered from a service-worker-mocked response.</p>
    </main>
  ),
};

export const Alice = { args: { name: 'Alice' } };
export const Bob = { args: { name: 'Bob' } };
