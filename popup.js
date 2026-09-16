/usr/local/Homebrew/Library/Homebrew/cmd/shellenv.sh: line 27: /bin/ps: Operation not permitted
const timeInput = document.querySelector('#refreshTime');
const startButton = document.querySelector('#start');
const cancelButton = document.querySelector('#cancel');
const statusBox = document.querySelector('#status');
const autoSelectInput = document.querySelector('#autoSelect');
const weekdayInput = document.querySelector('#weekday');
const periodsInput = document.querySelector('#periods');
const campusInput = document.querySelector('#campus');
const courseCategoryInput = document.querySelector('#courseCategory');
const courseTypeInput = document.querySelector('#courseType');
const courseKeywordInput = document.querySelector('#courseKeyword');
const oneMinuteLaterButton = document.querySelector('#oneMinuteLater');
const syncNowButton = document.querySelector('#syncNow');
const testSecondsInput = document.querySelector('#testSeconds');
const lastCourseBox = document.querySelector('#lastCourse');
const withdrawLastButton = document.querySelector('#withdrawLast');
document.querySelector('#version').textContent = `v${chrome.runtime.getManifest().version}`;

const COURSE_TYPES = {
  '学位公共课': ['政治理论课', '第一外国语', '专业外语'],
  '学科专业课': ['学位基础课', '学位专业课', '专业选修课', '学位核心课汇总', '选修课汇总'],
  '公共选修课': ['公共选修课'],
  '其他可选课程': ['其他可选课程']
};

function pad(value) {
  return String(value).padStart(2, '0');
}

function toInputValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function showStatus(text, type = '') {
  statusBox.textContent = text;
  statusBox.className = type;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.executionStatus?.newValue?.message) {
    const status = changes.executionStatus.newValue;
    showStatus(status.message, status.type || '');
  }
  if (area === 'local' && changes.lastSelectedCourse) {
    const course = changes.lastSelectedCourse.newValue;
    lastCourseBox.textContent = course?.code
      ? `${course.name || '课程'}（${course.code}）`
      : '尚无记录';
    withdrawLastButton.disabled = !course?.code;
  }
});

oneMinuteLaterButton.addEventListener('click', () => {
  const seconds = Math.min(300, Math.max(1, Number.parseInt(testSecondsInput.value, 10) || 5));
  testSecondsInput.value = String(seconds);
  const testTime = new Date(Math.ceil(Date.now() / 1000) * 1000 + seconds * 1000);
  timeInput.value = toInputValue(testTime);
  showStatus(`正在启动测试，将在 ${seconds} 秒后执行。`);
  setTimeout(() => startButton.click(), 0);
});

async function getActiveTab() {
  const tabs = await chrome.tabs.query({});
  const courseTabs = tabs.filter((tab) => {
    try { return new URL(tab.url).hostname === 'yjsxk.fudan.sh.cn'; } catch { return false; }
  });
  courseTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return courseTabs[0] || null;
}

function fillCourseTypes(preferred = '') {
  const types = COURSE_TYPES[courseCategoryInput.value] || [];
  courseTypeInput.replaceChildren();
  for (const type of types) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = type;
    courseTypeInput.appendChild(option);
  }
  if (types.includes(preferred)) courseTypeInput.value = preferred;
}

async function syncPageToSelection() {
  const tab = await getActiveTab();
  let url;
  try { url = new URL(tab?.url); } catch { url = null; }
  if (!url || url.hostname !== 'yjsxk.fudan.sh.cn') {
    showStatus('如需同步切换，请先打开复旦选课页面。你的选项仍会保留。', 'error');
    return;
  }
  const navigation = {
    courseCategory: courseCategoryInput.value,
    courseType: courseTypeInput.value
  };
  await chrome.storage.local.set({
    previewNavigation: { ...navigation, requestedAt: Date.now() },
    targetTabId: tab.id
  });
  try {
    showStatus(`已锁定最近使用的选课标签（标签ID ${tab.id}），正在切换页面……`);
    const result = await chrome.runtime.sendMessage({
      type: 'NAVIGATE_PAGE',
      tabId: tab.id,
      navigation
    });
    if (result?.cancelled) return;
    if (result?.ok) {
      await chrome.storage.local.set({ previewNavigation: null });
      showStatus(`页面已切换：${navigation.courseCategory} → ${navigation.courseType}`, 'ok');
    } else {
      showStatus(`页面中未找到${result?.missing || '目标标签'}，因此没有完成切换。`, 'error');
    }
    return;

    if (!chrome.scripting?.executeScript) {
      await chrome.tabs.sendMessage(tab.id, { type: 'PREVIEW_NAVIGATION', navigation });
      showStatus('已通过兼容方式发送切换指令。若页面没有变化，请到扩展管理页点击“重新加载”，再刷新选课网页。', 'error');
      return;
    }
    const clickLabel = async (label) => {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        args: [label],
        func: (wantedText) => {
          const normalize = (value) => (value || '').replace(/\s+/g, '');
          const wanted = normalize(wantedText);
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const selectors = 'a, button, [role="tab"], [role="button"], li';
          let target = [...document.querySelectorAll(selectors)]
            .find((element) => normalize(element.innerText || element.textContent) === wanted && visible(element));
          if (!target) {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              if (normalize(node.nodeValue) !== wanted) continue;
              const parent = node.parentElement;
              if (!parent || !visible(parent)) continue;
              target = parent.closest(selectors) || parent;
              break;
            }
          }
          if (!target) {
            const exactElements = [...document.querySelectorAll('body *')]
              .filter((element) => normalize(element.innerText || element.textContent) === wanted && visible(element))
              .sort((a, b) => {
                const childDifference = a.childElementCount - b.childElementCount;
                if (childDifference) return childDifference;
                const areaA = a.getBoundingClientRect().width * a.getBoundingClientRect().height;
                const areaB = b.getBoundingClientRect().width * b.getBoundingClientRect().height;
                return areaA - areaB;
              });
            const textElement = exactElements[0] || null;
            target = textElement?.closest(selectors) || textElement;
          }
          if (!target) return false;
          target.click();
          return true;
        }
      });
      return results.some((result) => result?.result === true);
    };

    let categoryFound = await clickLabel(navigation.courseCategory);
    let typeFound = false;
    for (let attempt = 0; attempt < 40 && !typeFound; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      typeFound = await clickLabel(navigation.courseType);
      if (!categoryFound && attempt % 4 === 3) {
        categoryFound = await clickLabel(navigation.courseCategory);
      }
    }
    if (categoryFound && typeFound) {
      await chrome.storage.local.set({ previewNavigation: null });
      showStatus(`页面已切换：${navigation.courseCategory} → ${navigation.courseType}`, 'ok');
    } else {
      await chrome.tabs.sendMessage(tab.id, { type: 'PREVIEW_NAVIGATION', navigation }).catch(() => {});
      const missing = [!categoryFound ? '课程大类' : '', !typeFound ? '课程类型' : ''].filter(Boolean).join('和');
      showStatus(`页面中未找到${missing}，因此没有完成切换。请确认选课页面已打开。`, 'error');
    }
  } catch (error) {
    showStatus(`无法同步页面：${error.message || '请刷新选课页面后重试。'}`, 'error');
  }
}

courseCategoryInput.addEventListener('change', () => {
  fillCourseTypes();
  syncPageToSelection();
});
courseTypeInput.addEventListener('change', syncPageToSelection);
syncNowButton.addEventListener('click', syncPageToSelection);

async function renderSavedState() {
  const saved = await chrome.storage.local.get(['armed', 'targetTime', 'targetTabId', 'lastFiredAt', 'autoSelect', 'selectionResult', 'selectionCriteria', 'executionStatus', 'testSeconds', 'lastSelectedCourse']);
  testSecondsInput.value = String(saved.testSeconds || 5);
  if (saved.lastSelectedCourse?.code) {
    lastCourseBox.textContent = `${saved.lastSelectedCourse.name || '课程'}（${saved.lastSelectedCourse.code}）`;
    withdrawLastButton.disabled = false;
  }
  if (saved.targetTime) timeInput.value = toInputValue(new Date(saved.targetTime));
  if (typeof saved.autoSelect === 'boolean') autoSelectInput.checked = saved.autoSelect;
  if (saved.selectionCriteria) {
    courseCategoryInput.value = saved.selectionCriteria.courseCategory || '学位公共课';
    fillCourseTypes(saved.selectionCriteria.courseType || '');
    courseKeywordInput.value = saved.selectionCriteria.courseKeyword || '';
    weekdayInput.value = saved.selectionCriteria.weekday ?? '';
    periodsInput.value = saved.selectionCriteria.periods || '';
    campusInput.value = saved.selectionCriteria.campus || '';
  }

  if (saved.executionStatus?.message) {
    showStatus(saved.executionStatus.message, saved.executionStatus.type || '');
  } else if (saved.armed && saved.targetTime) {
    showStatus(`已启动：将在 ${new Date(saved.targetTime).toLocaleString()} 刷新一次。请不要关闭当前选课标签页。`, 'ok');
  } else if (saved.selectionResult) {
    showStatus(saved.selectionResult, saved.selectionResult.includes('成功') ? 'ok' : 'error');
  } else if (saved.lastFiredAt) {
    showStatus(`上次已在 ${new Date(saved.lastFiredAt).toLocaleString()} 执行刷新。`);
  } else {
    showStatus('尚未启动。');
  }
}

startButton.addEventListener('click', async () => {
  const target = new Date(timeInput.value);
  if (!timeInput.value || Number.isNaN(target.getTime())) {
    showStatus('请先选择正确的日期和时间。', 'error');
    return;
  }
  if (target.getTime() <= Date.now()) {
    showStatus('执行时间必须晚于当前时间。', 'error');
    return;
  }

  const criteria = {
    courseCategory: courseCategoryInput.value.trim(),
    courseType: courseTypeInput.value.trim(),
    courseKeyword: courseKeywordInput.value.trim(),
    weekday: weekdayInput.value.trim(),
    periods: periodsInput.value.trim().replace(/[～—–至-]/g, '~').replace(/节/g, ''),
    campus: campusInput.value.trim()
  };
  const hasWeekday = Boolean(criteria.weekday);
  const hasPeriods = Boolean(criteria.periods);
  if (autoSelectInput.checked && (!criteria.courseCategory || !criteria.courseType || !criteria.courseKeyword)) {
    showStatus('自动点选时，课程大类、页面内课程类型、课程名称或代码都必须填写。', 'error');
    return;
  }
  if (autoSelectInput.checked && hasWeekday !== hasPeriods) {
    showStatus('按时间筛选时，星期和节次必须同时填写。', 'error');
    return;
  }

  const tab = await getActiveTab();
  let url;
  try { url = new URL(tab.url); } catch { url = null; }
  if (!url || url.hostname !== 'yjsxk.fudan.sh.cn') {
    showStatus('请先切换到复旦研究生选课页面，再点击“开始等待”。', 'error');
    return;
  }

  await chrome.storage.local.set({
    testSeconds: Math.min(300, Math.max(1, Number.parseInt(testSecondsInput.value, 10) || 5)),
    armed: true,
    targetTime: target.getTime(),
    targetTabId: tab.id,
    targetUrl: tab.url,
    lastFiredAt: null,
    autoSelect: autoSelectInput.checked,
    selectionCriteria: criteria,
    pendingAutoSelect: false,
    previewNavigation: null,
    navigationReady: false,
    selectionResult: null,
    executionStatus: {
      stage: 'waiting', message: `等待执行：${target.toLocaleString()}。已锁定最近使用的选课标签（标签ID ${tab.id}）。`, type: 'ok', updatedAt: Date.now()
    }
  });

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'RESCHEDULE_REFRESH' });
  } catch {
    showStatus('设置已保存。请刷新一次选课页面，让插件开始运行。', 'error');
    return;
  }
  const timeText = hasWeekday ? `${criteria.weekday} ${criteria.periods}节` : '';
  const campusText = criteria.campus || '';
  const criteriaText = [criteria.courseCategory, criteria.courseType, criteria.courseKeyword, timeText, campusText].filter(Boolean).join('、');
  const action = autoSelectInput.checked ? `刷新，并按“${criteriaText}、未满”条件点选一次` : '刷新一次';
  showStatus(`已启动：将在 ${target.toLocaleString()} ${action}。请保持本标签页打开。`, 'ok');
});

withdrawLastButton.addEventListener('click', async () => {
  const saved = await chrome.storage.local.get(['lastSelectedCourse']);
  const course = saved.lastSelectedCourse;
  if (!course?.code) {
    showStatus('没有可用于退选的课程记录。', 'error');
    return;
  }
  if (!confirm(`准备打开这门课的退选确认框：\n${course.name || ''}\n${course.code}\n\n最终“确定”需要你在网页上手动点击。`)) return;
  const tab = await getActiveTab();
  if (!tab?.id) {
    showStatus('没有找到复旦选课页面。', 'error');
    return;
  }
  showStatus(`正在进入“已选课程”并查找 ${course.code}……`);
  const result = await chrome.runtime.sendMessage({ type: 'WITHDRAW_LAST_COURSE', tabId: tab.id, course });
  showStatus(result?.message || '退选操作未完成。', result?.ok ? 'ok' : 'error');
});

cancelButton.addEventListener('click', async () => {
  await chrome.storage.local.set({
    armed: false, targetTime: null, targetTabId: null, pendingAutoSelect: false,
    executionStatus: { stage: 'cancelled', message: '任务已取消。', type: '', updatedAt: Date.now() }
  });
  const tab = await getActiveTab();
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'RESCHEDULE_REFRESH' }).catch(() => {});
  showStatus('任务已取消。');
});

const defaultTime = new Date();
defaultTime.setHours(13, 0, 0, 0);
if (defaultTime <= new Date()) defaultTime.setDate(defaultTime.getDate() + 1);
timeInput.value = toInputValue(defaultTime);
fillCourseTypes('政治理论课');
renderSavedState();
