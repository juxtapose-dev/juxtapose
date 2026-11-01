/* global window */
import { createApp, defineComponent, h, Fragment, Teleport, ref, nextTick } from 'vue';

const Leaf = defineComponent({ name: 'RepeatedLeaf', render: () => h('b', 'leaf') });
const Empty = defineComponent({ name: 'EmptyLeaf', render: () => null });
const Text = defineComponent({ name: 'TextLeaf', render: () => 'text leaf' });
const Multi = defineComponent({
  name: 'FragmentLeaf',
  render: () => h(Fragment, [h('i', 'first'), h('i', 'second')]),
});
const Portal = defineComponent({
  name: 'PortalLeaf',
  render: () => h(Teleport, { to: '#portal' }, [h('strong', 'teleported')]),
});
const Wrapper = defineComponent({
  name: 'SlotWrapper',
  setup:
    (_, { slots }) =>
    () =>
      h('section', slots.default()),
});
const App = defineComponent({
  name: 'FixtureRoot',
  setup() {
    const visible = ref(true);
    const many = ref(false);
    window.fillFixture = async () => {
      many.value = true;
      await nextTick();
    };
    window.updateFixture = async () => {
      visible.value = false;
      await nextTick();
    };
    return () =>
      h('main', [
        ...(many.value
          ? Array.from({ length: 1100 }, () => h(Leaf))
          : [h(Leaf), h(Leaf)]),
        h(Multi),
        h(Portal),
        h(Empty),
        h(Text),
        h(Wrapper, null, { default: () => h('small', 'slotted') }),
        visible.value
          ? h(
              defineComponent({
                name: 'TransientLeaf',
                render: () => h('em', 'updated'),
              }),
            )
          : h('u', 'replacement'),
      ]);
  },
});
createApp(App).mount('#app');
window.fixtureReady = true;
