// Fixed, local workloads for profiling. No wall clock, random data or remote assets.
import { useEffect, useState } from 'react';
import { Button, Card } from 'example-components';
import payloadUrl from './data.json?url';

export default {
  title: 'Profile',
  parameters: {
    juxtapose: {
      variants: {
        mobile: { viewport: { width: 390, height: 844 } },
        dark: { colorScheme: 'dark' },
        tablet: { viewport: { width: 768, height: 1024 } },
        'mobile-dark': { extends: 'mobile', colorScheme: 'dark' },
      },
    },
  },
};

const range = (n) => Array.from({ length: n }, (_, i) => i);
const sizes = { small: 12, medium: 72, large: 288 };
const frame = {
  fontFamily: 'system-ui, sans-serif',
  fontSize: 14,
  padding: 16,
  minHeight: 600,
  color: 'var(--ink)',
  background: 'var(--paper)',
};
const grid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 12,
};

function AsyncRows({ count }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let active = true;
    fetch(payloadUrl)
      .then((r) => r.json())
      .then((data) => {
        if (active) setRows(data);
      });
    return () => {
      active = false;
    };
  }, []);
  return rows ? (
    <ul data-profile-ready>
      {range(count).map((i) => (
        <li key={i}>
          {rows[i % rows.length].name}: {i * 13} units
        </li>
      ))}
    </ul>
  ) : (
    <p>Loading fixed local data…</p>
  );
}

function Workload({ kind, size }) {
  const n = sizes[size];
  let content;
  switch (kind) {
    case 'forms':
      content = (
        <form style={grid}>
          {range(n).map((i) => (
            <fieldset key={i}>
              <legend>Contact {i + 1}</legend>
              <label>
                Name <input defaultValue={`Person ${i + 1}`} />
              </label>
              <label>
                Role{' '}
                <select defaultValue="editor">
                  <option>reader</option>
                  <option>editor</option>
                </select>
              </label>
              <label>
                <input type="checkbox" defaultChecked={i % 2 === 0} /> Active
              </label>
              <Button label="Save" size="sm" />
            </fieldset>
          ))}
        </form>
      );
      break;
    case 'tables':
      content = (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['ID', 'Name', 'Status', 'Quantity', 'Owner', 'Actions'].map((x) => (
                <th key={x}>{x}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {range(n).map((i) => (
              <tr key={i} style={{ borderBottom: '1px solid #94a3b8' }}>
                <td>{i}</td>
                <td>Fixed record {i}</td>
                <td>{i % 3 ? 'Ready' : 'Pending'}</td>
                <td>{i * 17}</td>
                <td>Team {i % 7}</td>
                <td>
                  <button>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
      break;
    case 'cards':
      content = (
        <div style={grid}>
          {range(n).map((i) => (
            <Card
              key={i}
              title={`Project ${i}`}
              badge={i % 3 ? undefined : 'new'}
              body="Fixed content exercises wrapping, rounded edges, badges, and nested layout."
            />
          ))}
        </div>
      );
      break;
    case 'typography':
      content = (
        <div>
          {range(n).map((i) => (
            <p
              key={i}
              style={{
                fontSize: 12 + (i % 15),
                fontWeight: [400, 500, 700][i % 3],
                lineHeight: 1.4,
                maxWidth: 720,
              }}
            >
              Record {i}: The quick brown fox jumps over the lazy dog.{' '}
              <strong>Stable text</strong> <code>0123456789</code> wraps predictably
              across viewport sizes.
            </p>
          ))}
        </div>
      );
      break;
    case 'charts':
      content = (
        <svg
          width="100%"
          height="560"
          viewBox="0 0 1000 560"
          role="img"
          aria-label="Fixed data chart"
        >
          {range(n).map((i) => (
            <g key={i}>
              <rect
                x={(i * 31) % 980}
                y={40 + ((i * 17) % 400)}
                width="16"
                height={20 + ((i * 7) % 100)}
                fill={['#2563eb', '#e11d48', '#059669'][i % 3]}
                opacity="0.7"
              />
              <circle
                cx={(i * 47) % 980}
                cy={40 + ((i * 11) % 440)}
                r="3"
                fill="#f59e0b"
              />
            </g>
          ))}
          <text x="12" y="24" fill="currentColor">
            Deterministic series: {n} points
          </text>
        </svg>
      );
      break;
    case 'images':
      content = (
        <div style={grid}>
          {range(n).map((i) => {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><defs><linearGradient id="g"><stop stop-color="hsl(${(i * 37) % 360},70%,45%)"/><stop offset="1" stop-color="#ddd"/></linearGradient></defs><rect width="320" height="200" fill="url(#g)"/><circle cx="${40 + (i % 240)}" cy="100" r="70" fill="#fff" opacity=".4"/></svg>`;
            return (
              <figure key={i} style={{ margin: 0 }}>
                <img
                  width="180"
                  height="113"
                  src={`data:image/svg+xml,${encodeURIComponent(svg)}`}
                  alt={`Generated illustration ${i}`}
                  style={{ borderRadius: 12 }}
                />
                <figcaption>Local image {i}</figcaption>
              </figure>
            );
          })}
        </div>
      );
      break;
    case 'nested':
      content = (
        <div>
          {range(n).map((i) => (
            <section key={i}>
              <div style={{ paddingLeft: 8 }}>
                <article>
                  <header>
                    <strong>Group {i}</strong>
                  </header>
                  <ul>
                    {range(6).map((j) => (
                      <li key={j}>
                        <span>
                          Node {i}.{j}
                        </span>
                        <span> — fixed metadata</span>
                        <button aria-label={`Open ${i}.${j}`}>Open</button>
                      </li>
                    ))}
                  </ul>
                </article>
              </div>
            </section>
          ))}
        </div>
      );
      break;
    case 'async':
      content = <AsyncRows count={n} />;
      break;
  }
  return (
    <main style={frame}>
      <style>{`:root { --ink: #172033; --paper: #f8fafc; } @media(prefers-color-scheme:dark) { :root { --ink: #e2e8f0; --paper: #172033; } } input, select { max-width: 100%; } label { display: block; }`}</style>
      <h1>
        {kind} / {size}
      </h1>
      {content}
    </main>
  );
}

const story = (kind, size) => ({
  render: () => <Workload kind={kind} size={size} />,
  ...(kind === 'async'
    ? { parameters: { juxtapose: { waitForSelector: '[data-profile-ready]' } } }
    : {}),
});
export const FormsSmall = story('forms', 'small');
export const FormsMedium = story('forms', 'medium');
export const FormsLarge = story('forms', 'large');
export const TablesSmall = story('tables', 'small');
export const TablesMedium = story('tables', 'medium');
export const TablesLarge = story('tables', 'large');
export const CardsSmall = story('cards', 'small');
export const CardsMedium = story('cards', 'medium');
export const CardsLarge = story('cards', 'large');
export const TypographySmall = story('typography', 'small');
export const TypographyMedium = story('typography', 'medium');
export const TypographyLarge = story('typography', 'large');
export const ChartsSmall = story('charts', 'small');
export const ChartsMedium = story('charts', 'medium');
export const ChartsLarge = story('charts', 'large');
export const ImagesSmall = story('images', 'small');
export const ImagesMedium = story('images', 'medium');
export const ImagesLarge = story('images', 'large');
export const NestedSmall = story('nested', 'small');
export const NestedMedium = story('nested', 'medium');
export const NestedLarge = story('nested', 'large');
export const AsyncSmall = story('async', 'small');
export const AsyncMedium = story('async', 'medium');
export const AsyncLarge = story('async', 'large');
