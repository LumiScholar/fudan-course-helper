/usr/local/Homebrew/Library/Homebrew/cmd/shellenv.sh: line 27: /bin/ps: Operation not permitted
let navigationGeneration = 0;

const CATEGORY_LABELS = ['学位公共课', '学科专业课', '公共选修课', '其他可选课程'];
const TYPE_LABELS = {
  学位公共课: ['政治理论课', '第一外国语', '专业外语'],
  学科专业课: ['学位基础课', '学位专业课', '专业选修课', '学位核心课汇总', '选修课汇总']
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function inspectFrames(tabId, labels) {
  return chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    args: [labels],
    func: (wantedLabels) => {
      const normalize = (value) => (value || '').replace(/\s+/g, '');
      const bodyText = normalize(document.body?.innerText || '');
      return {
        present: wantedLabels.filter((label) => bodyText.includes(normalize(label))),
        tableRows: document.querySelectorAll('tr').length,
        visibleBody: Boolean(document.body)
      };
    }
  });
}

function chooseFrame(results, requiredLabels, minimumMatches) {
  return results
    .filter((entry) => entry?.result?.visibleBody)
    .map((entry) => ({
      frameId: entry.frameId,
      matches: requiredLabels.filter((label) => entry.result.present.includes(label)).length,
      rows: entry.result.tableRows || 0
    }))
    .filter((entry) => entry.matches >= minimumMatches)
    .sort((a, b) => (b.matches - a.matches) || (b.rows - a.rows))[0] || null;
}

async function clickLabelInFrame(tabId, frameId, label) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    args: [label],
    func: (wantedText) => {
      const normalize = (value) => (value || '').replace(/\s+/g, '');
      const wanted = normalize(wantedText);
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const realControlSelector = 'a, button, [role="tab"], [role="button"], input[type="button"]';
      const broadSelector = `${realControlSelector}, li`;
      const candidates = [...document.querySelectorAll(broadSelector)]
        .filter((element) => normalize(element.innerText || element.textContent || element.value) === wanted && visible(element))
        .sort((a, b) => {
          const aReal = a.matches(realControlSelector) ? 1 : 0;
          const bReal = b.matches(realControlSelector) ? 1 : 0;
          if (aReal !== bReal) return bReal - aReal;
          if (a.contains(b)) return 1;
          if (b.contains(a)) return -1;
          return (a.getBoundingClientRect().width * a.getBoundingClientRect().height)
            - (b.getBoundingClientRect().width * b.getBoundingClientRect().height);
        });
      let target = candidates[0] || null;
      if (!target) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (normalize(node.nodeValue) !== wanted) continue;
          const parent = node.parentElement;
          if (!parent || !visible(parent)) continue;
          target = parent.closest(realControlSelector) || parent;
          break;
        }
      }
      if (!target) return { clicked: false };
      target.scrollIntoView?.({ block: 'center', inline: 'center' });
      target.focus?.();
      for (const eventName of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        target.dispatchEvent(new MouseEvent(eventName, { bubbles: true, cancelable: true, view: window }));
      }
      target.click();
      return {
        clicked: true,
        tag: target.tagName,
        href: target.getAttribute?.('href') || '',
        hasOnclick: Boolean(target.onclick || target.getAttribute?.('onclick'))
      };
    }
  });
  return results.find((result) => result?.result?.clicked)?.result || { clicked: false };
}

async function navigateInTwoStages(tabId, navigation, generation) {
  if (navigation.trackExecution) {
    await chrome.storage.local.set({ executionStatus: {
      stage: 'switching_category', message: `正在切换课程大类：${navigation.courseCategory}`, type: '', updatedAt: Date.now()
    }});
  }
  let categoryFound = false;
  for (let attempt = 0; attempt < 20 && !categoryFound; attempt += 1) {
    if (generation !== navigationGeneration) return { ok: false, cancelled: true };
    try {
      const frames = await inspectFrames(tabId, CATEGORY_LABELS);
      const navFrame = chooseFrame(frames, CATEGORY_LABELS, 3);
      if (navFrame) {
        const clickResult = await clickLabelInFrame(tabId, navFrame.frameId, navigation.courseCategory);
        categoryFound = clickResult.clicked;
      }
    } catch {
      // The site can briefly replace its inner frames during refresh.
    }
    if (!categoryFound) await delay(250);
  }
  if (!categoryFound) {
    if (navigation.trackExecution) {
      await chrome.storage.local.set({ executionStatus: {
        stage: 'failed', message: `失败：找不到课程大类“${navigation.courseCategory}”。`, type: 'error', updatedAt: Date.now()
      }});
    }
    return { ok: false, missing: '课程大类' };
  }

  if (navigation.trackExecution) {
    await chrome.storage.local.set({ executionStatus: {
      stage: 'switching_type', message: `已找到课程大类，正在等待并切换类型：${navigation.courseType}`, type: '', updatedAt: Date.now()
    }});
  }

  const siblingTypes = TYPE_LABELS[navigation.courseCategory] || [navigation.courseType];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (generation !== navigationGeneration) return { ok: false, cancelled: true };
    await delay(250);
    try {
      const frames = await inspectFrames(tabId, siblingTypes);
      const typeFrame = chooseFrame(frames, siblingTypes, siblingTypes.length >= 3 ? 2 : 1);
      const clickResult = typeFrame
        ? await clickLabelInFrame(tabId, typeFrame.frameId, navigation.courseType)
        : { clicked: false };
      if (clickResult.clicked) {
        await delay(400);
        return { ok: true };
      }
    } catch {
      // The site's inner content may be rebuilding; keep trying until the deadline.
    }
  }
  if (navigation.trackExecution) {
    await chrome.storage.local.set({ executionStatus: {
      stage: 'failed', message: `失败：找不到或无法切换到课程类型“${navigation.courseType}”。`, type: 'error', updatedAt: Date.now()
    }});
  }
  return { ok: false, missing: '课程类型' };
}

async function withdrawRecordedCourse(tabId, course) {
  let selectedPageClicked = false;
  for (let attempt = 0; attempt < 20 && !selectedPageClicked; attempt += 1) {
    try {
      const frames = await inspectFrames(tabId, ['已选课程']);
      const frame = chooseFrame(frames, ['已选课程'], 1);
      if (frame) selectedPageClicked = (await clickLabelInFrame(tabId, frame.frameId, '已选课程')).clicked;
    } catch {
      // Retry while the page is settling.
    }
    if (!selectedPageClicked) await delay(250);
  }
  if (!selectedPageClicked) return { ok: false, message: '失败：没有找到顶部的“已选课程”。' };

  for (let attempt = 0; attempt < 80; attempt += 1) {
    await delay(250);
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      args: [course.code],
      func: (courseCode) => {
        const normalize = (value) => (value || '').replace(/\s+/g, '').toUpperCase();
        const wanted = normalize(courseCode);
        const visible = (element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        for (const row of document.querySelectorAll('tr')) {
          if (!normalize(row.innerText || row.textContent).includes(wanted)) continue;
          const button = [...row.querySelectorAll('button, a, [role="button"], input[type="button"]')]
            .find((element) => normalize(element.innerText || element.textContent || element.value) === '退选' && visible(element));
          if (!button) continue;
          row.style.outline = '3px solid #d92d20';
          button.click();
          return true;
        }
        return false;
      }
    });
    if (!results.some((entry) => entry?.result === true)) continue;
    await chrome.storage.local.set({
      executionStatus: {
        stage: 'withdraw_confirmation',
        message: `已对课程 ${course.code} 点击“退选”。请在网页弹窗中手动点击“确定”或“取消”。`,
        type: 'ok', updatedAt: Date.now()
      }
    });
    return { ok: true, message: `已找到 ${course.code} 并点击“退选”。最终“确定”请你在网页上手动点击。` };
  }
  return { ok: false, message: `失败：“已选课程”中没有找到课程代码 ${course.code}，未操作其他课程。` };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'GET_SENDER_TAB_ID') {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return;
  }
  if (message?.type === 'NAVIGATE_PAGE' && message.navigation) {
    const tabId = message.tabId ?? sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, missing: '选课标签页' });
      return;
    }
    const generation = ++navigationGeneration;
    navigateInTwoStages(tabId, message.navigation, generation)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'WITHDRAW_LAST_COURSE' && message.course) {
    const tabId = message.tabId ?? sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, message: '没有找到选课标签页。' });
      return;
    }
    withdrawRecordedCourse(tabId, message.course)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, message: `退选失败：${error.message}` }));
    return true;
  }
});
