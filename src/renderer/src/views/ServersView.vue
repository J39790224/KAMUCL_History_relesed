<script setup lang="ts">
// 服务器页：占位（功能开发中）
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">服务器</h1>
      <p class="page-sub">浏览与加入多人服务器</p>
    </div>

    <div class="card empty servers-empty">
      <svg class="servers-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="18" height="7" rx="2" />
        <rect x="3" y="13" width="18" height="7" rx="2" />
        <path d="M7 7.5h.01M7 16.5h.01" />
      </svg>
      <p class="servers-text">服务器功能开发中，敬请期待</p>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 940px;
  margin: 0 auto;
}
.servers-empty {
  padding: 72px 20px;
}
.servers-icon {
  width: 52px;
  height: 52px;
  color: var(--accent);
  opacity: 0.8;
}
.servers-text {
  font-size: 14px;
}
</style>
