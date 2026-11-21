<script lang="ts">
  // An optional meeting time: a day (quick chips or any date), a time (common times or any time)
  // and a length. Binds `value` = { startsAt: ms | null, durationMinutes }. Local time throughout.
  import { onMount, tick } from 'svelte';
  import Icon from '$lib/ui/Icon.svelte';
  import { DURATIONS, durationLabel } from '$lib/invites';
  import {
    TIME_SLOTS,
    buildDayOptions,
    combineDateTime,
    dayKey,
    defaultStart,
    formatRange,
    formatTimeOfDay,
    isPast,
    nextHalfHour,
    timeKey,
    timeZoneName,
    type When,
  } from '$lib/when';

  export let value: When;
  /** Prefix for element ids (unique on the page). */
  export let id: string;
  export let legend = 'When';
  /** Shown when no date is chosen. */
  export let emptyText = 'No date set.';

  let now = Date.now();
  onMount(() => {
    // Keep "Today" and the past-time check current while the page stays open.
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  /** "YYYY-MM-DD", or null for no date. */
  let day: string | null = value.startsAt != null ? dayKey(value.startsAt) : null;
  /** "HH:MM"; remembered while there's no date, so picking a day brings it back. */
  let time = timeKey(value.startsAt ?? defaultStart(now));
  let dateOpen = false;
  let timeOpen = false;
  let dateEl: HTMLInputElement;
  let timeEl: HTMLInputElement;

  // Follow changes made by the parent (e.g. the form clearing the time after use).
  let synced = value.startsAt;
  $: if (value.startsAt !== synced) adopt(value.startsAt);

  function adopt(startsAt: number | null) {
    synced = startsAt;
    if (startsAt == null) {
      day = null;
      dateOpen = false;
      return;
    }
    day = dayKey(startsAt);
    time = timeKey(startsAt);
  }

  function commit(startsAt = day ? combineDateTime(day, time) : null) {
    synced = startsAt;
    value = { ...value, startsAt };
  }

  $: days = buildDayOptions(now);
  $: today = dayKey(now);
  $: customDay = day !== null && !days.some((d) => d.key === day);
  $: customTime = !TIME_SLOTS.includes(time);
  $: durations = DURATIONS.includes(value.durationMinutes) ? DURATIONS : [...DURATIONS, value.durationMinutes].sort((a, b) => a - b);
  $: summary = value.startsAt != null ? formatRange(value.startsAt, value.durationMinutes) : '';
  $: zone = value.startsAt != null ? timeZoneName(value.startsAt) : '';

  /** Choose a day, keeping the time unless that would be in the past (then the next half hour). */
  function pickDay(key: string | null) {
    let startsAt = key ? combineDateTime(key, time) : null;
    if (startsAt !== null && startsAt < now) {
      startsAt = nextHalfHour(now);
      key = dayKey(startsAt);
      time = timeKey(startsAt);
    }
    day = key;
    if (key === null || !customDayKey(key)) dateOpen = false;
    commit(startsAt);
  }

  function customDayKey(key: string): boolean {
    return !days.some((d) => d.key === key);
  }

  async function openDate() {
    dateOpen = true;
    await tick();
    dateEl?.focus();
  }

  function onDateChange(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value;
    if (v && combineDateTime(v, '00:00') !== null) pickDay(v);
  }

  function pickTime(slot: string) {
    time = slot;
    timeOpen = false;
    commit();
  }

  async function openTime() {
    timeOpen = true;
    await tick();
    timeEl?.focus();
  }

  function onTimeChange(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value;
    if (/^\d{2}:\d{2}/.test(v)) {
      time = v.slice(0, 5);
      commit();
    }
  }

  function pickDuration(minutes: number) {
    value = { ...value, durationMinutes: minutes };
  }

  function slotPast(slot: string, selectedDay: string | null, current: number): boolean {
    return selectedDay !== null && isPast(selectedDay, slot, current);
  }
</script>

<fieldset class="when" aria-describedby="{id}-summary">
  <legend class="field-label">{legend}</legend>

  <div class="group" role="group" aria-labelledby="{id}-day">
    <span id="{id}-day" class="group-label">Day</span>
    <div class="chips">
      <button type="button" class="pick" aria-pressed={day === null} on:click={() => pickDay(null)}>No date</button>
      {#each days as d (d.key)}
        <button type="button" class="pick" aria-pressed={day === d.key} title={d.longLabel} on:click={() => pickDay(d.key)}>
          {d.label}<span class="sr-only">, {d.longLabel}</span>
        </button>
      {/each}
      <button type="button" class="pick" aria-pressed={customDay} aria-expanded={dateOpen || customDay} aria-controls="{id}-date" on:click={openDate}>
        <Icon name="calendar" size={14} /> Pick a date
      </button>
    </div>
    {#if dateOpen || customDay}
      <label class="sr-only" for="{id}-date">Date</label>
      <input
        id="{id}-date"
        bind:this={dateEl}
        class="input native"
        type="date"
        min={today}
        value={day ?? ''}
        on:change={onDateChange}
      />
    {/if}
  </div>

  {#if day !== null}
    <div class="group" role="group" aria-labelledby="{id}-time">
      <span id="{id}-time" class="group-label">Time</span>
      <div class="chips times">
        {#each TIME_SLOTS as slot (slot)}
          <button
            type="button"
            class="pick"
            aria-pressed={time === slot}
            disabled={slotPast(slot, day, now)}
            on:click={() => pickTime(slot)}
          >
            {formatTimeOfDay(slot)}
          </button>
        {/each}
        <button type="button" class="pick" aria-pressed={customTime} aria-expanded={timeOpen || customTime} aria-controls="{id}-clock" on:click={openTime}>
          {customTime ? formatTimeOfDay(time) : 'Other time…'}
        </button>
      </div>
      {#if timeOpen || customTime}
        <label class="sr-only" for="{id}-clock">Time</label>
        <input id="{id}-clock" bind:this={timeEl} class="input native" type="time" step="300" value={time} on:change={onTimeChange} />
      {/if}
    </div>

    <div class="group" role="group" aria-labelledby="{id}-length">
      <span id="{id}-length" class="group-label">Length</span>
      <div class="chips">
        {#each durations as d (d)}
          <button type="button" class="pick" aria-pressed={value.durationMinutes === d} on:click={() => pickDuration(d)}>{durationLabel(d)}</button>
        {/each}
      </div>
    </div>
  {/if}

  <p id="{id}-summary" class="summary" class:empty={value.startsAt == null} aria-live="polite">
    {#if value.startsAt != null}
      <Icon name="calendar" size={14} />
      <span><strong>{summary}</strong> <span class="zone">(your time{zone ? `, ${zone}` : ''})</span></span>
    {:else}
      <span>{emptyText}</span>
    {/if}
  </p>
</fieldset>

<style>
  .when {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
    border: none;
    padding: 0;
    margin: 0;
  }

  legend {
    padding: 0;
    margin-bottom: var(--space-1);
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .group-label {
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-subtle);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    min-width: 0;
  }

  .chips.times {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  }

  .pick {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 36px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    background: var(--bg-elevated);
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }

  .pick:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--bg-overlay);
  }

  .pick[aria-pressed='true'] {
    background: var(--accent);
    border-color: transparent;
    color: var(--accent-text);
  }

  .pick[aria-pressed='true']:hover:not(:disabled) {
    background: var(--accent-hover);
    border-color: transparent;
  }

  .pick:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: 2px;
    border-radius: var(--radius-pill);
  }

  .pick:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    text-decoration: line-through;
  }

  .native {
    width: auto;
    max-width: 100%;
    align-self: flex-start;
    color-scheme: inherit;
  }

  .summary {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .summary :global(svg) {
    flex-shrink: 0;
    margin-top: 2px;
    color: var(--accent);
  }

  .summary strong {
    font-weight: 600;
  }

  .summary.empty,
  .zone {
    color: var(--text-muted);
  }

  @media (max-width: 480px) {
    .chips.times {
      grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
    }
  }
</style>
