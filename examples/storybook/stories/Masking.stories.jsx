/**
 * A story whose content changes on every render.
 *
 * Without a mask this is permanently red: the timestamp differs each capture,
 * the hash differs, and no threshold can rescue it. It exists to prove the
 * mask works — and to be the honest example of when to reach for one.
 */
const Stamped = () => (
  <div style={{ fontFamily: 'system-ui', padding: 24 }}>
    <h3 style={{ margin: '0 0 8px' }}>Deploy succeeded</h3>
    <p style={{ margin: 0, color: '#64748b' }}>
      Finished at{' '}
      {/* nowrap: the ISO timestamp wrapped to two lines depending on its digits,
          changing the height of the masked box and its ancestors (18 vs 36 px). The box is wide enough that the text
          never overflows the mask. */}
      <span
        data-testid="clock"
        style={{ display: 'inline-block', width: 280, whiteSpace: 'nowrap' }}
      >
        {new Date().toISOString()}
      </span>
    </p>
  </div>
);

export default { title: 'Masking' };

export const Timestamp = {
  render: () => <Stamped />,
  parameters: { juxtapose: { mask: ['[data-testid="clock"]'] } },
};
