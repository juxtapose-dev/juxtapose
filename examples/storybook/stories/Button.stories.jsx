import { Button } from 'example-components';

export default { title: 'Button', component: Button };

export const Primary = { args: { label: 'Click me', variant: 'primary' } };
export const Secondary = { args: { label: 'Or me', variant: 'secondary' } };
export const Danger = { args: { label: 'Delete', variant: 'danger' } };
export const Ghost = { args: { label: 'Cancel', variant: 'ghost' } };

export const Small = { args: { label: 'Small', size: 'sm' } };
export const Large = { args: { label: 'Large', size: 'lg' } };
