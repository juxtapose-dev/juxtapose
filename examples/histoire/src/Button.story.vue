<script setup>
import Button from './Button.vue';
</script>

<!--
  One variant per Storybook story in the Vue example, so the two workbenches
  capture the same six renders under different ids.
-->
<template>
  <Story title="Button" :layout="{ type: 'grid', width: 400 }">
    <Variant title="Primary">
      <Button label="Click me" variant="primary" />
    </Variant>
    <Variant title="Secondary">
      <Button label="Or me" variant="secondary" />
    </Variant>
    <Variant title="Danger">
      <Button label="Delete" variant="danger" />
    </Variant>
    <Variant title="Ghost">
      <Button label="Cancel" variant="ghost" />
    </Variant>
    <Variant title="Small">
      <Button label="Small" size="sm" />
    </Variant>
    <Variant title="Large">
      <Button label="Large" size="lg" />
    </Variant>
    <!-- Proves per-variant config survives `histoire build` into histoire.json,
         which is why this adapter needs no readLiveParams. -->
    <Variant title="Skipped" :meta="{ juxtapose: { skip: true } }">
      <Button label="Never captured" />
    </Variant>
  </Story>
</template>
