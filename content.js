let refreshTimer = null;
let countdownTimer = null;
let badge = null;

function removeBadge() {
  badge?.remove();
  badge = null;
}

function ensureBadge() {
  if (badge) return badge;
  badge = document.createElement('div');
  badge.style.cssText = [
    'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
    'padding:10px 14px', 'border-radius:9px', 'background:#253a9a',
    'color:white', 'font:14px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
    'box-shadow:0 4px 16px rgba(0,0,0,.25)'
  ].join(';');
  document.documentElement.appendChild(badge);
  return badge;
}

function formatRemaining(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

async function fireOnce(targetTime) {
  const saved = await chrome.storage.local.get(['armed', 'targetTime', 'autoSelect']);
  if (!saved.armed || saved.targetTime !== targetTime) return;
  await chrome.storage.local.set({
    armed: false,
    lastFiredAt: Date.now(),
    pendingAutoSelect: saved.autoSelect === true,
    navigationReady: false,
    executionStatus: {
      stage: 'refreshing', message: '已到设定时间，正在刷新选课页面。', type: '', updatedAt: Date.now()
    }
  });
  location.reload();
}

function normalizedText(element) {
  return (element?.innerText || element?.textContent || '')
    .replace(/\s+/g, '')
    .replace(/[～—–至]/g, '~');
}

function isVisible(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

function safePageClick(element) {
  if (!element) return false;
  const href = element.getAttribute?.('href') || '';
  if (/^\s*javascript:/i.test(href)) {
    const preventJavascriptNavigation = (event) => event.preventDefault();
    element.addEventListener('click', preventJavascriptNavigation, { capture: true, once: true });
    element.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, composed: true, view: window
    }));
  } else {
    element.click();
  }
  return true;
}

function findSelectControl(row) {
  return [...row.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]')]
    .find((element) => {
      const text = normalizedText(element) || (element.value || '').replace(/\s+/g, '');
      return text === '选课' && isVisible(element) && !element.disabled;
    });
}

function activeTexts() {
  const activeElements = document.querySelectorAll(
    '.active, .on, .selected, .current, .layui-this, [aria-selected="true"]'
  );
  return [...activeElements].map(normalizedText);
}

function findVisibleClickableByExactText(text) {
  const wanted = normalizedText({ textContent: text });
  const directCandidates = [...document.querySelectorAll('a, button, [role="tab"], [role="button"], li')];
  const direct = directCandidates.find((element) => normalizedText(element) === wanted && isVisible(element));
  if (direct) return direct;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if ((node.nodeValue || '').replace(/\s+/g, '') !== wanted) continue;
    const parent = node.parentElement;
    if (!parent || !isVisible(parent)) continue;
    return parent.closest('a, button, [role="tab"], [role="button"], li') || parent;
  }

  const exactElements = [...document.querySelectorAll('body *')]
    .filter((element) => normalizedText(element) === wanted && isVisible(element))
    .sort((a, b) => {
      const childDifference = a.childElementCount - b.childElementCount;
      if (childDifference) return childDifference;
      const areaA = a.getBoundingClientRect().width * a.getBoundingClientRect().height;
      const areaB = b.getBoundingClientRect().width * b.getBoundingClientRect().height;
      return areaA - areaB;
    });
  const element = exactElements[0] || null;
  return element?.closest('a, button, [role="tab"], [role="button"], li') || element;
}

function elementLooksActive(element) {
  let current = element;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
    const classes = String(current.className || '').split(/\s+/);
    if (classes.some((name) => ['active', 'on', 'selected', 'current', 'layui-this'].includes(name))) return true;
    if (current.getAttribute?.('aria-selected') === 'true') return true;
  }
  return false;
}

let lastNavigationClick = 0;
function prepareCourseView(criteria) {
  const selected = activeTexts();
  const categoryControl = findVisibleClickableByExactText(criteria.courseCategory);
  const categoryReady = !categoryControl || elementLooksActive(categoryControl) || selected.some((text) => text.includes(criteria.courseCategory));
  if (categoryControl && !categoryReady) {
    if (categoryControl && Date.now() - lastNavigationClick > 1200) {
      lastNavigationClick = Date.now();
      safePageClick(categoryControl);
    }
    return false;
  }

  const typeControl = findVisibleClickableByExactText(criteria.courseType);
  const typeReady = Boolean(typeControl) && (elementLooksActive(typeControl) || selected.some((text) => text.includes(criteria.courseType)));
  if (typeControl && !typeReady) {
    if (typeControl && Date.now() - lastNavigationClick > 1200) {
      lastNavigationClick = Date.now();
      safePageClick(typeControl);
    }
    return false;
  }
  return typeReady;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rowMatchesCourseKeyword(row, keyword) {
  const wanted = normalizedText({ textContent: keyword || '' });
  if (!wanted) return false;
  const table = row.closest('table');
  const headers = table ? [...table.querySelectorAll('thead th, tr:first-child th')] : [];
  const indexes = headers
    .map((header, index) => ({ text: normalizedText(header), index }))
    .filter(({ text }) => text.includes('课程代码') || text.includes('课程名称'))
    .map(({ index }) => index);
  const cells = [...row.querySelectorAll('td')];
  if (indexes.length && cells.length) {
    return indexes.some((index) => normalizedText(cells[index]).includes(wanted));
  }
  return normalizedText(row).includes(wanted);
}

let lastSearchStats = { rows: 0, courseMatches: 0, conditionMatches: 0, availableMatches: 0 };

function findMatchingCourse(criteria) {
  const stats = { rows: 0, courseMatches: 0, conditionMatches: 0, availableMatches: 0 };
  const weekday = normalizedText({ textContent: criteria.weekday || '' });
  const periods = normalizedText({ textContent: criteria.periods || '' }).replace(/节/g, '');
  const campus = normalizedText({ textContent: criteria.campus || '' });
  const timePattern = weekday && periods
    ? new RegExp(`${escapeRegExp(weekday)}${escapeRegExp(periods)}节`)
    : null;
  for (const row of document.querySelectorAll('tr')) {
    if (!row.querySelector('td')) continue;
    stats.rows += 1;
    const text = normalizedText(row);
    const matchesCourse = rowMatchesCourseKeyword(row, criteria.courseKeyword);
    if (matchesCourse) stats.courseMatches += 1;
    const matchesTime = !timePattern || timePattern.test(text);
    const matchesCampus = !campus || text.includes(campus);
    const isAvailable = text.includes('未满');
    const control = findSelectControl(row);
    if (matchesCourse && matchesTime && matchesCampus) stats.conditionMatches += 1;
    if (matchesCourse && matchesTime && matchesCampus && isAvailable) stats.availableMatches += 1;
    if (matchesCourse && matchesTime && matchesCampus && isAvailable && control) {
      lastSearchStats = stats;
      return { row, control };
    }
  }
  lastSearchStats = stats;
  return null;
}

function courseRecordFromRow(row, criteria) {
  const cells = [...row.querySelectorAll('td')];
  const table = row.closest('table');
  const headers = table ? [...table.querySelectorAll('thead th, tr:first-child th')] : [];
  const headerIndex = (word) => headers.findIndex((header) => normalizedText(header).includes(word));
  const codeIndex = headerIndex('课程代码');
  const nameIndex = headerIndex('课程名称');
  const codeText = codeIndex >= 0 ? normalizedText(cells[codeIndex]) : '';
  const nameText = nameIndex >= 0 ? (cells[nameIndex]?.innerText || cells[nameIndex]?.textContent || '').trim() : '';
  const codeMatch = codeText.match(/[A-Z]{2,}\d{3,}(?:\.\d+)?/i)
    || normalizedText(row).match(/[A-Z]{2,}\d{3,}(?:\.\d+)?/i);
  return {
    code: codeMatch?.[0] || criteria.courseKeyword,
    name: nameText || criteria.courseKeyword,
    keyword: criteria.courseKeyword,
    recordedAt: Date.now()
  };
}

function clickSelectionConfirmationOnce() {
  const modalSelectors = [
    '.layui-layer', '.modal', '.modal-dialog', '.dialog',
    '[role="dialog"]', '.el-message-box', '.ant-modal'
  ];
  const deadline = Date.now() + 5000;
  const timer = setInterval(async () => {
    const containers = [...document.querySelectorAll(modalSelectors.join(','))].filter(isVisible);
    if (!containers.length) containers.push(document.body);
    for (const container of containers) {
      const confirm = [...container.querySelectorAll('button, a, [role="button"], input[type="button"]')]
        .find((element) => ['确定', '确认'].includes(normalizedText(element) || normalizedText({ textContent: element.value })) && isVisible(element));
      if (!confirm) continue;
      clearInterval(timer);
      safePageClick(confirm);
      await chrome.storage.local.set({ executionStatus: {
        stage: 'confirmed',
        message: '已自动点击“选课”和弹窗“确定”。请到“已选课程”页面核对最终结果。',
        type: 'ok', updatedAt: Date.now()
      }});
      return;
    }
    if (Date.now() > deadline) {
      clearInterval(timer);
      await chrome.storage.local.set({ executionStatus: {
        stage: 'clicked',
        message: '已点击“选课”，但5秒内没有发现确认按钮。请查看当前网页。',
        type: 'error', updatedAt: Date.now()
      }});
    }
  }, 100);
}

async function attemptAutoSelect() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_SENDER_TAB_ID' });
  const saved = await chrome.storage.local.get(['pendingAutoSelect', 'targetTabId', 'selectionCriteria']);
  if (!saved.pendingAutoSelect || response?.tabId !== saved.targetTabId) return;

  const criteria = saved.selectionCriteria || {
    courseCategory: '学位公共课', courseType: '政治理论课', courseKeyword: '',
    weekday: '', periods: '', campus: ''
  };
  if (window.top === window) {
    const navigationResult = await chrome.runtime.sendMessage({
      type: 'NAVIGATE_PAGE',
      tabId: response?.tabId,
      navigation: {
        courseCategory: criteria.courseCategory,
        courseType: criteria.courseType,
        trackExecution: true
      }
    }).catch(() => null);
    await chrome.storage.local.set({
      navigationReady: navigationResult?.ok === true,
      executionStatus: navigationResult?.ok ? {
        stage: 'searching',
        message: `已切换到“${criteria.courseCategory} → ${criteria.courseType}”，正在查找符合条件的课程。`,
        type: '', updatedAt: Date.now()
      } : {
        stage: 'failed',
        message: `失败：无法完成“${criteria.courseCategory} → ${criteria.courseType}”页面切换，因此没有点击课程。`,
        type: 'error', updatedAt: Date.now()
      }
    });
  }
  const timeLabel = criteria.weekday && criteria.periods ? `${criteria.weekday} ${criteria.periods}节` : '';
  const criteriaLabel = [criteria.courseCategory, criteria.courseType, criteria.courseKeyword, timeLabel, criteria.campus].filter(Boolean).join('、');

  const deadline = Date.now() + 35000;
  let lastProgressUpdate = 0;
  const timer = setInterval(async () => {
    const readiness = await chrome.storage.local.get(['navigationReady']);
    if (!readiness.navigationReady) {
      if (Date.now() > deadline) {
        clearInterval(timer);
        await chrome.storage.local.set({
          pendingAutoSelect: false,
          selectionResult: `刷新后等待了 35 秒，但没有成功切换到“${criteria.courseCategory} → ${criteria.courseType}”，因此没有点击任何课程。`,
          executionStatus: {
            stage: 'failed',
            message: `失败：刷新后35秒内没有成功切换到“${criteria.courseCategory} → ${criteria.courseType}”，未点击任何课程。`,
            type: 'error', updatedAt: Date.now()
          }
        });
      }
      return;
    }
    if (!document.querySelector('tr td')) {
      if (Date.now() > deadline) clearInterval(timer);
      return;
    }
    const match = findMatchingCourse(criteria);
    if (match) {
      clearInterval(timer);
      const selectedCourse = courseRecordFromRow(match.row, criteria);
      await chrome.storage.local.set({
        pendingAutoSelect: false,
        lastSelectedCourse: selectedCourse,
        selectionResult: `已找到符合“${criteriaLabel}”且未满的课程，正在自动完成选课确认。`,
        executionStatus: {
          stage: 'selection_confirmation',
          message: `已找到符合“${criteriaLabel}”且未满的课程，正在点击“选课”和弹窗“确定”。`,
          type: 'ok', updatedAt: Date.now()
        }
      });
      match.row.style.outline = '3px solid #20a162';
      safePageClick(match.control);
      clickSelectionConfirmationOnce();
      return;
    }
    if (Date.now() - lastProgressUpdate > 1000) {
      lastProgressUpdate = Date.now();
      const stats = lastSearchStats;
      await chrome.storage.local.set({ executionStatus: {
        stage: 'searching',
        message: `正在查找：已检查${stats.rows}行；课程关键词命中${stats.courseMatches}行；时间/校区条件命中${stats.conditionMatches}行；其中未满${stats.availableMatches}行。`,
        type: '', updatedAt: Date.now()
      }});
    }
    if (Date.now() > deadline) {
      clearInterval(timer);
      await chrome.storage.local.set({
        pendingAutoSelect: false,
        selectionResult: `刷新后等待了 35 秒，但未能切换到指定课程类型，或没有找到同时符合“${criteriaLabel}、未满、有选课按钮”的课程，因此没有点击。`,
        executionStatus: {
          stage: 'failed',
          message: `失败：等待35秒后仍没有找到同时符合“${criteriaLabel}、未满、有选课按钮”的课程。`,
          type: 'error', updatedAt: Date.now()
        }
      });
    }
  }, 100);
}

async function schedule() {
  clearTimeout(refreshTimer);
  clearInterval(countdownTimer);
  removeBadge();

  const saved = await chrome.storage.local.get(['armed', 'targetTime']);
  if (!saved.armed || !saved.targetTime) return;

  const remaining = saved.targetTime - Date.now();
  if (remaining <= -10000) {
    await chrome.storage.local.set({ armed: false });
    return;
  }

  const indicator = ensureBadge();
  const update = () => {
    indicator.textContent = `定时刷新倒计时 ${formatRemaining(saved.targetTime - Date.now())}`;
  };
  update();
  countdownTimer = setInterval(update, 250);
  refreshTimer = setTimeout(() => fireOnce(saved.targetTime), Math.max(0, remaining));
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'RESCHEDULE_REFRESH' && window.top === window) schedule();
});

attemptAutoSelect();
