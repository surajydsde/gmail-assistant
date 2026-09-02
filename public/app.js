document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const elBtnConnect = document.getElementById('btn-connect');
  const elBtnSync = document.getElementById('btn-sync');
  const elBtnSyncText = document.getElementById('btn-sync-text');
  const elIndicator = document.getElementById('connection-indicator');
  const elLastSyncText = document.getElementById('last-sync-text');

  const elMetricTotal = document.getElementById('metric-total');
  const elMetricUnread = document.getElementById('metric-unread');
  const elMetricAction = document.getElementById('metric-action');
  const elMetricPriority = document.getElementById('metric-priority');

  const elInputSearch = document.getElementById('input-search');
  const elPrioritySegments = document.querySelectorAll('#priority-segments .segment');
  const elCategoryChips = document.querySelectorAll('#category-chips .chip');

  const elEmailList = document.getElementById('email-list');
  const elLoader = document.getElementById('loader');
  const elEmpty = document.getElementById('empty');

  // Drawer Elements
  const elBackdrop = document.getElementById('drawer-backdrop');
  const elDrawerClose = document.getElementById('drawer-close');
  const elDCategory = document.getElementById('d-category');
  const elDPriority = document.getElementById('d-priority');
  const elDSubject = document.getElementById('d-subject');
  const elDSender = document.getElementById('d-sender');
  const elDDate = document.getElementById('d-date');
  const elDAvatar = document.getElementById('d-avatar');
  const elDSummary = document.getElementById('d-summary');
  const elDBody = document.getElementById('d-body');
  const elDLink = document.getElementById('d-link');

  // Filter State
  let currentCategory = 'ALL';
  let currentPriority = 'ALL';
  let currentSearch = '';
  let emailCache = [];

  // Authentication Status Check
  async function checkAuthStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();

      if (data.authenticated) {
        elIndicator.classList.add('connected');
        elBtnConnect.classList.add('hidden');
        if (data.lastSyncAt) {
          const syncDate = new Date(data.lastSyncAt);
          elLastSyncText.textContent = `Synced ${syncDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        } else {
          elLastSyncText.textContent = 'Auto-Sync Active';
        }
      } else {
        elIndicator.classList.remove('connected');
        elBtnConnect.classList.remove('hidden');
        elLastSyncText.textContent = 'Gmail Disconnected';
      }
    } catch (err) {
      console.error('Status check error:', err);
    }
  }

  // Connect Redirect
  elBtnConnect.addEventListener('click', async () => {
    try {
      const res = await fetch('/auth/url');
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch (err) {
      alert('Unable to load Google authorization URL.');
    }
  });

  // Manual Trigger
  elBtnSync.addEventListener('click', async () => {
    try {
      elBtnSync.disabled = true;
      elBtnSyncText.textContent = 'Syncing...';
      const icon = elBtnSync.querySelector('.icon-refresh');
      if (icon) icon.style.animation = 'spin 0.8s linear infinite';

      const res = await fetch('/api/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      await refreshAll();
    } catch (err) {
      alert(`Sync Error: ${err.message}`);
    } finally {
      elBtnSync.disabled = false;
      elBtnSyncText.textContent = 'Sync Mailbox';
      const icon = elBtnSync.querySelector('.icon-refresh');
      if (icon) icon.style.animation = 'none';
    }
  });

  // Load KPI Metrics
  async function loadMetrics() {
    try {
      const res = await fetch('/api/metrics');
      const data = await res.json();

      animateValue(elMetricTotal, parseInt(elMetricTotal.textContent) || 0, data.total, 500);
      animateValue(elMetricUnread, parseInt(elMetricUnread.textContent) || 0, data.unread, 500);
      animateValue(elMetricAction, parseInt(elMetricAction.textContent) || 0, data.actionRequired, 500);
      animateValue(elMetricPriority, parseInt(elMetricPriority.textContent) || 0, data.highPriority, 500);
    } catch (err) {
      console.error('Metrics loading error:', err);
    }
  }

  // Number Counter Animation
  function animateValue(obj, start, end, duration) {
    if (start === end) {
      obj.textContent = end;
      return;
    }
    let startTimestamp = null;
    const step = (timestamp) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / duration, 1);
      obj.textContent = Math.floor(progress * (end - start) + start);
      if (progress < 1) {
        window.requestAnimationFrame(step);
      }
    };
    window.requestAnimationFrame(step);
  }

  // Fetch & Render Emails
  async function loadEmails() {
    try {
      elLoader.classList.remove('hidden');
      elEmpty.classList.add('hidden');
      elEmailList.innerHTML = '';

      const query = new URLSearchParams({
        category: currentCategory,
        priority: currentPriority,
        search: currentSearch
      });

      const res = await fetch(`/api/emails?${query.toString()}`);
      emailCache = await res.json();

      elLoader.classList.add('hidden');

      if (emailCache.length === 0) {
        elEmpty.classList.remove('hidden');
        return;
      }

      emailCache.forEach(email => {
        const row = document.createElement('div');
        row.className = `email-row ${email.isUnread ? 'is-unread' : ''} ${email.isReviewed ? 'is-reviewed' : ''}`;

        const initials = getInitials(email.sender);
        const dateStr = formatDate(email.receivedAt);

        // Priority meter classes
        let meterFillClass = 'fill-low';
        if (email.priorityScore >= 70) meterFillClass = 'fill-high';
        else if (email.priorityScore >= 40) meterFillClass = 'fill-med';

        row.innerHTML = `
          <div class="col-sender">
            <span class="sender-title">${escapeHtml(email.sender)}</span>
            <span class="sender-time">${dateStr}</span>
          </div>
          <div class="col-content">
            <span class="content-subject">${escapeHtml(email.subject)}</span>
            <span class="content-summary">${escapeHtml(email.summary || email.snippet)}</span>
          </div>
          <div class="col-category">
            <span class="badge badge-tag">${email.category}</span>
            ${email.isActionRequired ? '<span class="badge badge-action-required">Action Required</span>' : ''}
          </div>
          <div class="col-actions">
            <div class="priority-meter">
              <span class="priority-number">${email.priorityScore}</span>
              <div class="meter-track">
                <div class="meter-fill ${meterFillClass}"></div>
              </div>
            </div>
          </div>
        `;

        row.addEventListener('click', () => openEmailDrawer(email));
        elEmailList.appendChild(row);
      });
    } catch (err) {
      console.error('Email loading error:', err);
      elLoader.classList.add('hidden');
    }
  }

  // Drawer Inspection Details
  function openEmailDrawer(email) {
    elDCategory.textContent = email.category;
    elDPriority.textContent = `Priority ${email.priorityScore}/100`;
    elDSubject.textContent = email.subject;
    elDSender.textContent = `${email.sender} <${email.senderEmail || ''}>`;
    elDDate.textContent = new Date(email.receivedAt).toLocaleString();
    elDAvatar.textContent = getInitials(email.sender);
    elDSummary.textContent = email.summary || 'No explicit executive summary generated.';
    elDBody.textContent = email.bodyPreview || email.snippet || 'No plain text preview available.';
    elDLink.href = `https://mail.google.com/mail/u/0/#inbox/${email.threadId}`;

    elBackdrop.classList.remove('hidden');
  }

  elDrawerClose.addEventListener('click', () => elBackdrop.classList.add('hidden'));
  elBackdrop.addEventListener('click', (e) => {
    if (e.target === elBackdrop) elBackdrop.classList.add('hidden');
  });

  // Helpers
  function getInitials(name) {
    if (!name) return 'EX';
    const parts = name.trim().split(' ');
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  function formatDate(isoStr) {
    const d = new Date(isoStr);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  async function refreshAll() {
    await checkAuthStatus();
    await loadMetrics();
    await loadEmails();
  }

  // Segment Priority Handlers
  elPrioritySegments.forEach(segment => {
    segment.addEventListener('click', () => {
      elPrioritySegments.forEach(s => s.classList.remove('active'));
      segment.classList.add('active');
      currentPriority = segment.dataset.priority;
      loadEmails();
    });
  });

  // Category Chip Handlers
  elCategoryChips.forEach(chip => {
    chip.addEventListener('click', () => {
      elCategoryChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentCategory = chip.dataset.category;
      loadEmails();
    });
  });

  // Debounced Search Handler
  let searchTimeout = null;
  elInputSearch.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      currentSearch = elInputSearch.value.trim();
      loadEmails();
    }, 280);
  });

  // Keyboard Shortcut: Cmd/Ctrl + K to focus search
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      elInputSearch.focus();
    }
    if (e.key === 'Escape' && !elBackdrop.classList.contains('hidden')) {
      elBackdrop.classList.add('hidden');
    }
  });

  // Initial Load
  refreshAll();
});