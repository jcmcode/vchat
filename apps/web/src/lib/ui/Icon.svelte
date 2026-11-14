<script lang="ts">
  /**
   * Inline stroke icons. 24x24 viewBox, 2px stroke, currentColor.
   * Paths are hand-drawn in a Lucide-like style (no external assets).
   * Usage: <Icon name="mic" size={20} />  (decorative unless `label` is set)
   */
  export let name: string;
  export let size: number | string = 20;
  export let strokeWidth: number | string = 2;
  export let label = '';

  const ICONS: Record<string, string> = {
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v4"/>',
    'mic-off':
      '<path d="M15 9.3V5a3 3 0 0 0-5.7-1.3"/><path d="M9 9v2a3 3 0 0 0 4.5 2.6"/><path d="M5 11a7 7 0 0 0 11.2 5.6"/><path d="M19 11a7 7 0 0 1-.6 2.8"/><path d="M12 18v4"/><path d="M3 3l18 18"/>',
    video: '<rect x="2" y="6" width="14" height="12" rx="3"/><path d="M16 10.5l5.2-3a.6.6 0 0 1 .8.5v8a.6.6 0 0 1-.8.5l-5.2-3"/>',
    'video-off':
      '<path d="M10.5 6H13a3 3 0 0 1 3 3v2.5"/><path d="M16 14.5V15a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V9a3 3 0 0 1 2-2.8"/><path d="M16 10.5l5.2-3a.6.6 0 0 1 .8.5v8a.6.6 0 0 1-.8.5l-1.7-1"/><path d="M3 3l18 18"/>',
    'screen-share':
      '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="M12 13V8"/><path d="M9.5 10.5L12 8l2.5 2.5"/>',
    'screen-share-off':
      '<path d="M7 3h13a2 2 0 0 1 2 2v10"/><path d="M18 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 .5-1.3"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="M3 3l18 18"/>',
    message: '<path d="M21 12a8 8 0 0 1-11.7 7.1L3 21l1.9-5.8A8 8 0 1 1 21 12z"/>',
    smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2.5 4 2.5S16 14 16 14"/><path d="M9 9.5h.01"/><path d="M15 9.5h.01"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    'phone-off':
      '<path d="M2.5 14.5c1-3.6 5.5-6.5 9.5-6.5s8.5 2.9 9.5 6.5c.2.8-.2 1.600-1 1.900l-3 1a1.500 1.500 0 0 1-1.900-1l-.4-1.600a1.500 1.500 0 0 0-1-1.100 9.500 9.500 0 0 0-4.400 0 1.500 1.500 0 0 0-1 1.100l-.4 1.600a1.500 1.500 0 0 1-1.900 1l-3-1a1.600 1.600 0 0 1-1-1.900z"/>',
    users:
      '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.500 6.500 0 0 1 13 0"/><path d="M16 4.700a3.500 3.500 0 0 1 0 6.600"/><path d="M18 14.200a6.500 6.500 0 0 1 3.500 5.800"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check: '<path d="M4 12.500l5 5L20 6.500"/>',
    x: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    send: '<path d="M21.500 2.500L10.500 13.500"/><path d="M21.500 2.500l-7 19-4-8-8-4z"/>',
    paperclip: '<path d="M21 11.500l-8.500 8.500a5.500 5.500 0 0 1-7.800-7.800l8.800-8.800a3.700 3.700 0 0 1 5.200 5.200l-8.800 8.800a1.800 1.800 0 0 1-2.600-2.600l8-8"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
    pen: '<path d="M17 3a2.800 2.800 0 0 1 4 4L7.500 20.500 2 22l1.500-5.500z"/><path d="M15 5l4 4"/>',
    laser: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/><path d="M5 5l2 2"/><path d="M17 17l2 2"/><path d="M19 5l-2 2"/><path d="M5 19l2-2"/>',
    eraser: '<path d="M20 20H9l-5.500-5.500a2 2 0 0 1 0-2.800L13 2.200a2 2 0 0 1 2.800 0l5.500 5.500a2 2 0 0 1 0 2.800L12 20"/><path d="M7 11l6 6"/>',
    undo: '<path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 1 2.600 6.400"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    whiteboard: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M7 14l3-4 3 2 4-5"/><path d="M8 21l2-4"/><path d="M16 21l-2-4"/>',
    link: '<path d="M10 14a4.500 4.500 0 0 0 6.400 0l3-3a4.500 4.500 0 0 0-6.400-6.400l-1 1"/><path d="M14 10a4.500 4.500 0 0 0-6.400 0l-3 3a4.500 4.500 0 0 0 6.400 6.400l1-1"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.600 13.500l6.800 4"/><path d="M15.400 6.500l-6.800 4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6"/>',
    'more-horizontal': '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    minimize: '<path d="M3 8h3a2 2 0 0 0 2-2V3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/>',
    'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    'shield-check': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
    'shield-alert': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
    highlighter: '<path d="M9 11l-6 6v3h9l3-3"/><path d="M22 12l-4.600 4.600a2 2 0 0 1-2.800 0l-5.200-5.200a2 2 0 0 1 0-2.800L14 4"/>',
    type: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-3.100-3.100a2 2 0 0 0-2.800 0L6 21"/>',
    'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
    'mouse-pointer': '<path d="M3 3l7.100 17.500 2.500-7.900 7.900-2.500z"/><path d="M13 13l6 6"/>',
    hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.500V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.800 0-4.500-.900-6-2.400L2.400 16a2 2 0 0 1 2.800-2.800L7 15"/>',
    'zoom-in': '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.300-4.300"/><path d="M11 8v6"/><path d="M8 11h6"/>',
    'zoom-out': '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.300-4.300"/><path d="M8 11h6"/>',
    fit: '<path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
    bold: '<path d="M7 4h6a4 4 0 0 1 0 8H7z"/><path d="M7 12h7a4 4 0 0 1 0 8H7z"/>',
    italic: '<path d="M19 4h-9"/><path d="M14 20H5"/><path d="M15 4L9 20"/>',
    underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><path d="M4 21h16"/>',
    list: '<path d="M9 6h12"/><path d="M9 12h12"/><path d="M9 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    'list-ordered': '<path d="M10 6h11"/><path d="M10 12h11"/><path d="M10 18h11"/><path d="M4 4h1v4"/><path d="M4 8h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.500-2-1"/>',
    move: '<path d="M12 2v20"/><path d="M2 12h20"/><path d="M9 5l3-3 3 3"/><path d="M9 19l3 3 3-3"/><path d="M5 9l-3 3 3 3"/><path d="M19 9l3 3-3 3"/>',
    'file-doc': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13l1.500 5 1.500-4 1.500 4 1.500-5"/>',
  };

  $: body = ICONS[name] ?? '';
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden={label ? undefined : 'true'}
  aria-label={label || undefined}
  role={label ? 'img' : undefined}
  focusable="false"
  class="vc-icon"
  {...$$restProps}
>
  {@html body}
</svg>

<style>
  .vc-icon {
    flex: none;
    display: inline-block;
    vertical-align: middle;
  }
</style>
