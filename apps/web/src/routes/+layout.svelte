<script>
  import { onMount } from 'svelte';
  import '../app.css';
  import { pruneSavedRooms } from '$lib/stores/room';

  // Expired rooms (their links and keys) are dropped from this browser whenever the app opens,
  // not only when the dashboard is visited.
  onMount(pruneSavedRooms);
</script>

<slot />
