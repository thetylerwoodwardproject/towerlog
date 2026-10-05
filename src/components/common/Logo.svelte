<script lang="ts">
  // The Towerlog mark: a radio tower in a white rounded square.
  let { size = 28, class: cls = '' }: { size?: number; class?: string } = $props();
</script>

<span class="inline-flex flex-none items-center justify-center bg-foreground {cls}" style="width:{size}px;height:{size}px;border-radius:{Math.round(size * 0.22)}px" aria-hidden="true">
  <svg width={Math.round(size * 0.64)} height={Math.round(size * 0.64)} viewBox="0 0 24 24" fill="none" stroke="#09090b" stroke-width={size >= 48 ? 2.2 : size >= 28 ? 2.4 : 2.6} stroke-linecap="round"><path d="M4.9 16.1C1 12.2 1 5.8 4.9 1.9" /><path d="M7.8 4.7a6.14 6.14 0 0 0-.8 7.5" /><circle cx="12" cy="9" r="2" /><path d="M16.2 4.8c2 2 2.26 5.11.8 7.47" /><path d="M19.1 1.9a9.96 9.96 0 0 1 0 14.1" /><path d="M9.5 18h5" /><path d="m8 22 4-11 4 11" /></svg>
</span>
