<script lang="ts">
  // Credits: the open-source projects Towerlog is built on.
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import StatusBadge from '../common/StatusBadge.svelte';
  import Section from './Section.svelte';
  import Panel from './Panel.svelte';

  type Credit = [name: string, by: string, licence: string, url: string, use: string];
  const groups: [string, Credit[]][] = [
    ['Streaming', [
      ['FFmpeg', 'FFmpeg developers', 'LGPL-2.1+ / GPL', 'https://ffmpeg.org', 'Reading every feed, recording, MP3 monitoring'],
      ['LAME', 'The LAME project', 'LGPL-2.0', 'https://lame.sourceforge.io', 'MP3 encoder used by FFmpeg for the listen-in player'],
      ['Icecast', 'Xiph.Org Foundation', 'GPL-2.0', 'https://icecast.org', 'The source protocol Pi-Tuner and encoders use to push streams to Towerlog'],
    ]],
    ['Web application', [
      ['Node.js', 'OpenJS Foundation', 'MIT', 'https://nodejs.org', 'Runtime for the engine and web server'],
      ['Astro', 'The Astro Technology Company & contributors', 'MIT', 'https://astro.build', 'Web framework (SSR, API routes)'],
      ['Svelte', 'Svelte contributors', 'MIT', 'https://svelte.dev', 'UI components'],
      ['Tailwind CSS', 'Tailwind Labs', 'MIT', 'https://tailwindcss.com', 'Styling'],
      ['shadcn-svelte', 'huntabyte & contributors', 'MIT', 'https://shadcn-svelte.com', 'UI component library (port of shadcn/ui)'],
      ['Bits UI', 'huntabyte & contributors', 'MIT', 'https://bits-ui.com', 'Headless components under shadcn-svelte'],
      ['Lucide', 'Lucide contributors', 'ISC', 'https://lucide.dev', 'Icons'],
      ['svelte-sonner', 'wobsoriano', 'MIT', 'https://github.com/wobsoriano/svelte-sonner', 'Toast notifications'],
      ['tailwind-variants, tailwind-merge, clsx, tw-animate-css', 'their authors', 'MIT', 'https://www.tailwind-variants.org', 'Class utilities and animations'],
      ['ws', 'Einar Otto Stangvik & contributors', 'MIT', 'https://github.com/websockets/ws', 'Live dashboard WebSocket'],
      ['Nodemailer', 'Andris Reinman', 'MIT-0', 'https://nodemailer.com', 'SMTP email alerts'],
      ['net-snmp', 'Mark Abrahams, Stephen Vickers & contributors', 'MIT', 'https://github.com/markabrahams/node-net-snmp', 'SNMP agent and traps'],
      ['Zod', 'Colin McDonnell & contributors', 'MIT', 'https://zod.dev', 'Settings validation'],
      ['Vite, esbuild, Vitest, TypeScript', 'their authors', 'MIT / Apache-2.0', 'https://vite.dev', 'Build tooling and tests'],
    ]],
    ['Monitoring & heritage', [
      ['Zabbix', 'Zabbix SIA', 'AGPL-3.0', 'https://www.zabbix.com', 'Monitoring target (trapper protocol, template format)'],
      ['Pi-Tuner 1.x', 'The Tyler Woodward Project', 'MIT', 'https://github.com/thetylerwoodwardproject/pi-tuner', 'The SDR streaming server Towerlog was forked from'],
    ]],
  ];
</script>

<Section title="Credits" description="Towerlog stands on these open-source projects. Thank you to everyone who builds and maintains them. Towerlog itself is MIT-licensed. ffmpeg is a separate program that Towerlog runs; its licence is its own.">
  {#each groups as [title, list] (title)}
    <Panel {title}>
      {#each list as [name, by, licence, url, use] (name)}
        <div class="flex items-start gap-4 border-b px-5 py-3 text-[13px] last:border-b-0 max-sm:px-4">
          <div class="w-[220px] flex-none max-sm:w-auto max-sm:flex-1">
            <a href={url} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 font-medium hover:underline">{name} <ExternalLink class="size-3 text-muted-foreground" /></a>
            <div class="text-xs text-muted-foreground">{by}</div>
          </div>
          <div class="min-w-0 flex-1 text-xs text-subtle max-sm:hidden">{use}</div>
          <StatusBadge dot={false} class="h-5 flex-none font-mono text-[10px]">{licence}</StatusBadge>
        </div>
      {/each}
    </Panel>
  {/each}
</Section>
