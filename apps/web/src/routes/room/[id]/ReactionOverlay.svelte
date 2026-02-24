<script lang="ts">
  import type { Reaction } from '$lib/webrtc/mesh';

  export let reactions: Reaction[];
</script>

<div class="reaction-overlay">
  {#each reactions as r (r.id)}
    <span class="floating-emoji" style="left: {20 + Math.random() * 60}%">
      {r.emoji}
    </span>
  {/each}
</div>

<style>
  .reaction-overlay {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 40;
    overflow: hidden;
  }

  .floating-emoji {
    position: absolute;
    bottom: 80px;
    font-size: 2.5rem;
    animation: float-up 2.5s ease-out forwards;
  }

  @keyframes float-up {
    0% {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
    70% {
      opacity: 1;
      transform: translateY(-300px) scale(1.2);
    }
    100% {
      opacity: 0;
      transform: translateY(-400px) scale(0.8);
    }
  }
</style>
