<template>
  <section class="creator-card" aria-label="启动器创作者">
    <div class="creator-heading">
      <span class="creator-eyebrow">创作者 <span aria-hidden="true">/ CREATOR</span></span>
      <span class="creator-pixels" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    </div>
    <p class="creator-intro">由人见人爱，花见花开的 UP 主</p>
    <p class="creator-signature"><strong>卡慕<span>SaMa</span></strong><span class="creator-made">制作</span></p>
    <a
      class="creator-link"
      href="https://space.bilibili.com/9596327"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="访问卡慕SaMa的哔哩哔哩主页（在浏览器中打开）"
    >
      <span class="creator-link-label">
        <svg class="bilibili-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m7 3 3 3m7-3-3 3" /><rect x="3" y="6" width="18" height="14" rx="4" />
          <path d="M8 11v3m8-3v3m-5 2 1 1 1-1M7 20v1m10-1v1" />
        </svg>
        <span>来 B 站找我</span>
      </span>
      <svg class="creator-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 18 18 6M7 6h11v11" /></svg>
    </a>
  </section>
</template>

<style scoped>
.creator-card {
  position: relative;
  min-width: 0;
  padding: 17px 18px 14px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: linear-gradient(135deg, var(--accent-soft), transparent 65%), color-mix(in srgb, var(--card) 88%, transparent);
  color: var(--text);
  box-shadow: var(--shadow);
}
.creator-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 14px; }
.creator-eyebrow { color: var(--text-dim); font-size: 10px; font-weight: 650; letter-spacing: 1px; }
.creator-eyebrow span { margin-left: 4px; font-size: 9px; letter-spacing: 1.4px; }
.creator-pixels { display: grid; grid-template-columns: repeat(2, 5px); gap: 3px; transform: rotate(-8deg); }
.creator-pixels i { width: 5px; height: 5px; border-radius: 1px; background: var(--accent-2); }
.creator-pixels i:nth-child(2) { opacity: 0.35; transform: translate(2px, -2px); }
.creator-pixels i:nth-child(3) { opacity: 0.55; }
.creator-intro { margin: 0; color: var(--text-dim); font-size: 11px; line-height: 1.7; text-wrap: pretty; }
.creator-signature { display: flex; align-items: baseline; flex-wrap: wrap; gap: 9px; margin: 5px 0 15px; }
.creator-signature strong { font-size: 23px; font-weight: 750; line-height: 1.3; letter-spacing: 0.2px; }
.creator-signature strong span { margin-left: 4px; font-size: 20px; font-weight: 600; letter-spacing: -0.6px; }
.creator-made { color: var(--text-dim); font-size: 11px; }
.creator-link { display: flex; min-height: 42px; align-items: center; justify-content: space-between; gap: 10px; padding: 0 11px; border: 1px solid var(--border); border-radius: 9px; background: var(--card-2); color: var(--text); text-decoration: none; transition: background 180ms ease, border-color 180ms ease; }
.creator-link-label { display: inline-flex; align-items: center; gap: 9px; font-size: 12px; font-weight: 600; }
.bilibili-icon { width: 23px; height: 23px; flex: none; color: var(--accent-2); }
.creator-arrow { width: 16px; height: 16px; flex: none; color: var(--text-dim); transition: transform 180ms ease; }
.creator-link:hover { background: var(--hover); border-color: var(--accent); }
.creator-link:hover .creator-arrow { transform: translate(1px, -1px); color: var(--text); }
.creator-link:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) {
  .creator-link, .creator-arrow { transition: none; }
  .creator-link:hover .creator-arrow { transform: none; }
}
</style>
