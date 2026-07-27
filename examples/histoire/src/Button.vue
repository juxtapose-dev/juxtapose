<!--
  Deliberately mirrors examples/storybook-vue's inline Button.

  Same pixels, different workbench. If juxtapose behaves differently here than
  on the Storybook Vue example, that is the adapter's fault — which is exactly
  what this example exists to catch.
-->
<script setup>
import { computed } from 'vue';

const props = defineProps({
  label: { type: String, default: 'Button' },
  variant: { type: String, default: 'primary' },
  size: { type: String, default: 'md' },
});

const style = computed(() => {
  const palette = {
    primary: { bg: '#2563eb', fg: '#ffffff' },
    secondary: { bg: '#64748b', fg: '#ffffff' },
    danger: { bg: '#dc2626', fg: '#ffffff' },
    ghost: { bg: 'transparent', fg: '#2563eb' },
  }[props.variant];
  const sizing = {
    sm: { padding: '6px 12px', fontSize: '14px' },
    md: { padding: '10px 20px', fontSize: '16px' },
    lg: { padding: '14px 28px', fontSize: '18px' },
  }[props.size];
  return {
    ...sizing,
    fontFamily: 'system-ui, sans-serif',
    border: props.variant === 'ghost' ? '1px solid #2563eb' : 'none',
    borderRadius: '6px',
    color: palette.fg,
    background: palette.bg,
    cursor: 'pointer',
  };
});
</script>

<template>
  <button :style="style">{{ label }}</button>
</template>
