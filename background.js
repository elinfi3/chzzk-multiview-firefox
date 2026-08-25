/**
 * @file background.js - 백그라운드 서비스 워커 (툴바 아이콘 클릭 시 독립 탭 멀티뷰어 실행)
 */

// 툴바 아이콘 클릭 시 multiview/index.html 독립 탭 생성
browser.action.onClicked.addListener(async () => {
  try {
    await browser.tabs.create({
      url: browser.runtime.getURL('multiview/index.html')
    });
  } catch (err) {
    console.error('멀티뷰어 탭 생성 오류:', err);
  }
});