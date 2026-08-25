document.addEventListener("DOMContentLoaded", () => {
  const openBtn = document.getElementById("open-multiview-btn");
  const addCurrentBtn = document.getElementById("add-current-btn");

  const multiviewUrl = browser.runtime.getURL("multiview/index.html");

  openBtn.addEventListener("click", () => {
    browser.tabs.create({ url: multiviewUrl });
    window.close();
  });

  addCurrentBtn.addEventListener("click", async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const currentUrl = tabs[0]?.url || "";

    let targetUrl = multiviewUrl;
    const match = currentUrl.match(/chzzk\.naver\.com\/live\/([a-zA-Z0-9]+)/);
    if (match && match[1]) {
      targetUrl += `?channelId=${match[1]}`;
    }

    browser.tabs.create({ url: targetUrl });
    window.close();
  });
});