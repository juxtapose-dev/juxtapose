// Toggle this flag to reproduce the intentional review demo regression.
const changed = false;

function ProjectAccess() {
  const muted = '#667085';
  const border = '#e4e7ec';
  const button = {
    border: `1px solid ${border}`,
    borderRadius: 7,
    padding: '10px 16px',
    font: '600 13px system-ui',
    background: '#fff',
    color: '#344054',
  };
  return (
    <main
      style={{
        width: 600,
        boxSizing: 'border-box',
        padding: 24,
        fontFamily: 'system-ui, sans-serif',
        background: '#fff',
        color: '#182230',
        border: `1px solid ${border}`,
        borderRadius: 14,
        boxShadow: '0 4px 16px #10182808',
      }}
    >
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: 10,
            background: '#f2f0ff',
            color: '#6941c6',
            display: 'grid',
            placeItems: 'center',
            fontSize: 21,
            fontWeight: 700,
          }}
        >
          A
        </div>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 1, fontWeight: 700, color: muted }}>
            ACME / WEBSITE
          </div>
          <h1 style={{ fontSize: 23, lineHeight: '29px', margin: '3px 0 0' }}>
            Project access
          </h1>
        </div>
        <span
          style={{
            marginLeft: 'auto',
            color: '#067647',
            background: '#ecfdf3',
            border: '1px solid #abefc6',
            borderRadius: 20,
            padding: '4px 9px',
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          Private project
        </span>
      </div>
      <p
        style={{
          margin: '17px 0 22px',
          color: muted,
          fontSize: 13,
          lineHeight: '20px',
          maxWidth: changed ? 320 : 550,
        }}
      >
        Choose who can view your project and publish changes.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <label style={{ flex: 1, fontSize: 12, fontWeight: 600 }}>
          Invite a teammate
          <input
            aria-label="Email address"
            value="alex@acme.design"
            readOnly
            style={{
              display: 'block',
              width: '100%',
              boxSizing: 'border-box',
              marginTop: 7,
              border: `1px solid ${border}`,
              padding: '10px 12px',
              borderRadius: 7,
              font: '13px system-ui',
              color: muted,
              background: '#fff',
            }}
          />
        </label>
        <button style={{ ...button, alignSelf: 'end' }}>Send invite</button>
      </div>
      <div
        style={{ borderTop: `1px solid ${border}`, borderBottom: `1px solid ${border}` }}
      >
        {[
          ['JL', 'Jordan Lee', 'jordan@acme.design', 'Owner', '#f4ebff', '#6941c6'],
          ['SK', 'Sam Kim', 'sam@acme.design', 'Editor', '#e0f2fe', '#026aa2'],
        ].map(([initials, name, email, role, bg, fg]) => (
          <div
            key={email}
            style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 0' }}
          >
            <div
              style={{
                display: 'grid',
                placeItems: 'center',
                width: 34,
                height: 34,
                borderRadius: '50%',
                background: bg,
                color: fg,
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {initials}
            </div>
            <div style={{ fontSize: 12, lineHeight: '18px' }}>
              <strong>{name}</strong>
              <div style={{ color: muted, fontSize: 11 }}>{email}</div>
            </div>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: muted }}>{role}</span>
          </div>
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '18px 0',
        }}
      >
        <div>
          <strong style={{ fontSize: 12 }}>Allow link sharing</strong>
          <div style={{ fontSize: 11, color: muted, marginTop: 4 }}>
            Anyone with the link can preview this project.
          </div>
        </div>
        <button
          role="switch"
          aria-checked="true"
          aria-label="Allow link sharing"
          style={{
            width: 34,
            height: 20,
            padding: 2,
            border: 0,
            borderRadius: 12,
            background: '#7f56d9',
          }}
        >
          <span
            style={{
              display: 'block',
              width: 16,
              height: 16,
              marginLeft: 14,
              background: '#fff',
              borderRadius: '50%',
            }}
          />
        </button>
      </div>
      <footer
        style={{
          borderTop: `1px solid ${border}`,
          paddingTop: 16,
          display: 'flex',
          justifyContent: changed ? 'space-between' : 'flex-end',
          gap: 8,
        }}
      >
        <button style={button}>Cancel</button>
        <button
          style={{
            ...button,
            background: '#6941c6',
            borderColor: '#6941c6',
            color: '#fff',
          }}
        >
          Save changes
        </button>
      </footer>
    </main>
  );
}
export default {
  title: 'Workflow/Project access',
  component: ProjectAccess,
  parameters: {
    layout: 'padded',
    juxtapose: { viewport: { width: 632, height: 560 } },
  },
};
export const Default = {};
