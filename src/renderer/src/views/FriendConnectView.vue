<script setup lang="ts">
import FriendConnect from '../components/FriendConnect.vue'
</script>

<template>
  <div class="page friend-connect-page">
    <h2 class="page-title">好友直连</h2>
    <p class="page-sub">创建本机房间、加入朋友的世界与查看联机状态。</p>
    <FriendConnect />
  </div>
</template>

<style scoped>
.friend-connect-page { max-width: 1120px; margin: 0 auto; }
</style>
