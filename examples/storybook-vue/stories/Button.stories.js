// Deliberately mirrors examples/storybook/stories/Button.stories.jsx.
//
// Same components, different renderer. If juxtapose behaves differently here
// than on the React example, that is the adapter's fault — which is exactly
// what this example exists to catch.

const Button = {
  props: {
    label: { default: 'Button' },
    variant: { default: 'primary' },
    size: { default: 'md' },
  },
  template: `
    <button :style="style">{{ label }}</button>
  `,
  computed: {
    style() {
      const palette = {
        primary: { bg: '#2563eb', fg: '#ffffff' },
        secondary: { bg: '#64748b', fg: '#ffffff' },
        danger: { bg: '#dc2626', fg: '#ffffff' },
        ghost: { bg: 'transparent', fg: '#2563eb' },
      }[this.variant];
      const sizing = {
        sm: { padding: '6px 12px', fontSize: '14px' },
        md: { padding: '10px 20px', fontSize: '16px' },
        lg: { padding: '14px 28px', fontSize: '18px' },
      }[this.size];
      return {
        ...sizing,
        fontFamily: 'system-ui, sans-serif',
        border: this.variant === 'ghost' ? '1px solid #2563eb' : 'none',
        borderRadius: '6px',
        color: palette.fg,
        background: palette.bg,
        cursor: 'pointer',
      };
    },
  },
};

export default { title: 'Button', component: Button };

export const Primary = { args: { label: 'Click me', variant: 'primary' } };
export const Secondary = { args: { label: 'Or me', variant: 'secondary' } };
export const Danger = { args: { label: 'Delete', variant: 'danger' } };
export const Ghost = { args: { label: 'Cancel', variant: 'ghost' } };
export const Small = { args: { label: 'Small', size: 'sm' } };
export const Large = { args: { label: 'Large', size: 'lg' } };
