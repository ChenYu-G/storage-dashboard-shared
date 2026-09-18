;(function () {
	'use strict'

	// ---------------------------------------------------------------------
	// DOM references
	// ---------------------------------------------------------------------
	const dropZone = document.getElementById('dropZone')
	const fileInput = document.getElementById('fileInput')
	const fileNameEl = document.getElementById('fileName')
	const sheetTabsEl = document.getElementById('sheetTabs')
	const mappingBlock = document.getElementById('mappingBlock')
	const parseHint = document.getElementById('parseHint')
	const colBin = document.getElementById('colBin')
	const colMaterial = document.getElementById('colMaterial')
	const colBatch = document.getElementById('colBatch')
	const capacityInput = document.getElementById('capacity')
	const processBtn = document.getElementById('processBtn')
	const emptyState = document.getElementById('emptyState')
	const resultsHead = document.getElementById('resultsHead')
	const resultsList = document.getElementById('resultsList')
	const resultsTitle = document.getElementById('resultsTitle')
	const searchMaterial = document.getElementById('searchMaterial')
	const searchBatch = document.getElementById('searchBatch')
	const searchBin = document.getElementById('searchBin')
	const onlyAvailable = document.getElementById('onlyAvailable')
	const searchNote = document.getElementById('searchNote')
	const statRow = document.getElementById('statRow')
	const statBins = document.getElementById('statBins')
	const statLines = document.getElementById('statLines')
	const statOver = document.getElementById('statOver')
	const statusDot = document.getElementById('statusDot')
	const statusText = document.getElementById('statusText')
	const syncNowBtn = document.getElementById('syncNowBtn')
	const ghRepo = document.getElementById('ghRepo')
	const ghBranch = document.getElementById('ghBranch')
	const ghPath = document.getElementById('ghPath')
	const ghToken = document.getElementById('ghToken')
	const ghConnectBtn = document.getElementById('ghConnectBtn')
	const ghDisconnectBtn = document.getElementById('ghDisconnectBtn')
	const ghHint = document.getElementById('ghHint')
	const ghSettings = document.getElementById('ghSettings')
	const ghSummaryDot = document.getElementById('ghSummaryDot')
	const ghSummaryText = document.getElementById('ghSummaryText')

	function updateGhSummary(connected, label) {
		ghSummaryDot.className = 'gh-summary-dot ' + (connected ? 'on' : 'off')
		ghSummaryText.textContent = label
	}

	// ---------------------------------------------------------------------
	// Persistence layer
	// ---------------------------------------------------------------------
	// Two backends, same Store interface (load / save):
	//   - No GitHub config saved  -> plain browser localStorage (per device,
	//     same as before — the default until you connect a repo).
	//   - GitHub config saved     -> the dataset is committed as a JSON file
	//     in a repo you choose, via the GitHub Contents API. Any device that
	//     enters the same repo + token reads/writes the same file, and a
	//     10s poll picks up changes made from other devices.
	// This works on the Free plan (and hosted anywhere, e.g. GitHub Pages)
	// because it's plain fetch() to api.github.com, not a Claude-specific
	// storage capability.
	const LOCAL_KEY = 'binDashboard.dataset.v1'
	const GH_CONFIG_KEY = 'binDashboard.ghConfig.v1'
	let ghSha = null // last known blob sha, for conflict-safe writes
	let ghPollTimer = null
	let pendingWrites = 0 // count of local edits queued/saving — polling pauses while > 0

	function getGhConfig() {
		try {
			return JSON.parse(localStorage.getItem(GH_CONFIG_KEY)) || null
		} catch (e) {
			return null
		}
	}
	function setGhConfig(cfg) {
		localStorage.setItem(GH_CONFIG_KEY, JSON.stringify(cfg))
	}
	function clearGhConfig() {
		localStorage.removeItem(GH_CONFIG_KEY)
	}
	function ghApiUrl(cfg) {
		const encPath = cfg.path
			.split('/')
			.filter(Boolean)
			.map(encodeURIComponent)
			.join('/')
		return `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${encPath}`
	}
	function b64EncodeUnicode(str) {
		return btoa(
			encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) =>
				String.fromCharCode('0x' + p1),
			),
		)
	}
	function b64DecodeUnicode(str) {
		return decodeURIComponent(
			atob(str.replace(/\n/g, ''))
				.split('')
				.map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
				.join(''),
		)
	}
	function ghHeaders(cfg, extra) {
		return Object.assign(
			{
				Authorization: 'Bearer ' + cfg.token,
				Accept: 'application/vnd.github+json',
			},
			extra || {},
		)
	}
	// Wraps fetch() with a few retries for pure network-level failures
	// (dropped wifi, VPN hiccup, flaky mobile connection — these surface
	// as a TypeError "Failed to fetch" before any HTTP response exists).
	// Real HTTP responses (401, 404, 409, ...) are returned immediately,
	// not retried here — the caller decides what to do with those.
	async function ghFetch(url, options, attempts) {
		attempts = attempts || 3
		for (let i = 0; i < attempts; i++) {
			try {
				return await fetch(url, options)
			} catch (e) {
				if (i === attempts - 1) throw e
				await new Promise((r) => setTimeout(r, 400 * Math.pow(2, i)))
			}
		}
	}

	const Store = {
		async load() {
			const cfg = getGhConfig()
			if (!cfg) {
				try {
					const raw = localStorage.getItem(LOCAL_KEY)
					return raw ? JSON.parse(raw) : null
				} catch (e) {
					console.error('Store.load (local) failed', e)
					return null
				}
			}
			const res = await ghFetch(
				ghApiUrl(cfg) + '?ref=' + encodeURIComponent(cfg.branch),
				{ headers: ghHeaders(cfg) },
			)
			if (res.status === 404) {
				ghSha = null
				return null
			}
			if (!res.ok) {
				const detail = await res.text().catch(() => '')
				let reason = ''
				try {
					reason = JSON.parse(detail).message || ''
				} catch (e) {
					reason = detail.slice(0, 200)
				}
				throw new Error(
					'GitHub load failed (HTTP ' + res.status + ')' +
						(reason ? ': ' + reason : ''),
				)
			}
			const j = await res.json()
			ghSha = j.sha
			return JSON.parse(b64DecodeUnicode(j.content))
		},
		async save(dataset) {
			const cfg = getGhConfig()
			if (!cfg) {
				try {
					localStorage.setItem(LOCAL_KEY, JSON.stringify(dataset))
					return true
				} catch (e) {
					console.error('Store.save (local) failed', e)
					return false
				}
			}
			const body = {
				message: 'Update bin dashboard data — ' + new Date().toISOString(),
				content: b64EncodeUnicode(JSON.stringify(dataset, null, 2)),
				branch: cfg.branch,
			}
			if (ghSha) body.sha = ghSha
			let res = await ghFetch(ghApiUrl(cfg), {
				method: 'PUT',
				headers: ghHeaders(cfg, { 'Content-Type': 'application/json' }),
				body: JSON.stringify(body),
			})
			if (res.status === 409 || res.status === 422) {
				// Someone else committed first — refetch the latest sha and retry once.
				const latest = await ghFetch(
					ghApiUrl(cfg) + '?ref=' + encodeURIComponent(cfg.branch),
					{ headers: ghHeaders(cfg) },
				)
				if (latest.ok) {
					const lj = await latest.json()
					ghSha = lj.sha
					body.sha = ghSha
					res = await ghFetch(ghApiUrl(cfg), {
						method: 'PUT',
						headers: ghHeaders(cfg, { 'Content-Type': 'application/json' }),
						body: JSON.stringify(body),
					})
				}
			}
			if (!res.ok) {
				const detail = await res.text().catch(() => '')
				let reason = ''
				try {
					reason = JSON.parse(detail).message || ''
				} catch (e) {
					reason = detail.slice(0, 200)
				}
				throw new Error(
					'GitHub save failed (HTTP ' + res.status + ')' +
						(reason ? ': ' + reason : ''),
				)
			}
			const j = await res.json()
			ghSha = j.content.sha
			return true
		},
	}

	const GH_POLL_MS = 2000 // conditional requests below make this cheap on the rate limit
	let ghPolling = false // reentrancy guard so focus/manual triggers can't overlap the interval tick
	let ghEtag = null // last response ETag — lets us poll via conditional GET

	async function ghPollOnce() {
		const cfg = getGhConfig()
		if (!cfg || ghPolling) return
		if (pendingWrites > 0) return // a local edit is still queued/saving — don't let a read clobber it
		ghPolling = true
		try {
			const headers = ghHeaders(cfg)
			if (ghEtag) headers['If-None-Match'] = ghEtag
			const res = await ghFetch(
				ghApiUrl(cfg) + '?ref=' + encodeURIComponent(cfg.branch),
				{ headers },
			)
			if (res.status === 304) return // nothing changed — and this doesn't count against the rate limit
			if (!res.ok) return
			const newEtag = res.headers.get('etag')
			if (newEtag) ghEtag = newEtag
			const j = await res.json()
			if (j.sha && j.sha !== ghSha) {
				ghSha = j.sha
				const data = JSON.parse(b64DecodeUnicode(j.content))
				if (data && Array.isArray(data.bins)) {
					state.capacity = data.capacity || 32
					state.bins = data.bins.map(finalizeBin)
					state.fileName = data.fileName || ''
					capacityInput.value = state.capacity
					renderAll()
					statusDot.className = 'dot on'
					statusText.textContent =
						'Synced — updated just now from another device.'
				}
			}
		} catch (e) {
			// Transient poll error — ignore, next tick will retry.
		} finally {
			ghPolling = false
		}
	}

	function startGhPolling() {
		if (ghPollTimer) clearInterval(ghPollTimer)
		ghPollTimer = setInterval(ghPollOnce, GH_POLL_MS)
	}
	function stopGhPolling() {
		if (ghPollTimer) clearInterval(ghPollTimer)
		ghPollTimer = null
	}

	// Catch up immediately when the tab regains focus/visibility, instead
	// of waiting for the next timer tick — this is the biggest lever for
	// "why hasn't the other device's change shown up yet".
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') ghPollOnce()
	})
	window.addEventListener('focus', () => ghPollOnce())

	syncNowBtn.addEventListener('click', async () => {
		if (!getGhConfig()) {
			statusText.textContent = 'Connect GitHub above to enable sync.'
			return
		}
		syncNowBtn.classList.remove('spinning')
		void syncNowBtn.offsetWidth // restart the CSS animation on repeat clicks
		syncNowBtn.classList.add('spinning')
		syncNowBtn.disabled = true
		await ghPollOnce()
		syncNowBtn.disabled = false
	})

	// ---------------------------------------------------------------------
	// Parsing state (left panel, before a dashboard exists)
	// ---------------------------------------------------------------------
	let workbook = null,
		sheetNames = [],
		headers = [],
		rows = []

	// ---------------------------------------------------------------------
	// App state (right panel)
	// bins: [{ id, bin, lines: [{ key, material, batch, palletCount }], totalPallets }]
	// ---------------------------------------------------------------------
	const state = { capacity: 32, bins: [], fileName: '' }

	const BIN_SYNONYMS = [
		'storage bin',
		'storagebin',
		'storage bin location',
		'bin',
		'bin location',
		'storage bin (source)',
	]
	const MAT_SYNONYMS = ['material', 'material number', 'material no']
	const BATCH_SYNONYMS = ['batch', 'batch number', 'batch no']

	function norm(s) {
		return String(s || '')
			.trim()
			.toLowerCase()
			.replace(/[\s_-]+/g, '')
	}

	function guessColumn(hdrs, synonyms) {
		const normHdrs = hdrs.map(norm)
		for (const syn of synonyms) {
			const ns = norm(syn)
			const idx = normHdrs.findIndex((h) => h === ns)
			if (idx !== -1) return hdrs[idx]
		}
		for (const syn of synonyms) {
			const ns = norm(syn)
			const idx = normHdrs.findIndex((h) => h.includes(ns) || ns.includes(h))
			if (idx !== -1) return hdrs[idx]
		}
		return ''
	}

	// ---------------------------------------------------------------------
	// Excel loading
	// ---------------------------------------------------------------------
	function loadSheet(name) {
		const ws = workbook.Sheets[name]
		const json = XLSX.utils.sheet_to_json(ws, { defval: '' })
		rows = json
		headers = json.length ? Object.keys(json[0]) : []
		;[...sheetTabsEl.children].forEach((el) =>
			el.classList.toggle('active', el.dataset.sheet === name),
		)

		if (headers.length === 0) {
			parseHint.textContent = 'This sheet has no readable rows.'
			mappingBlock.style.display = 'none'
			return
		}
		populateSelect(colBin, headers, guessColumn(headers, BIN_SYNONYMS))
		populateSelect(colMaterial, headers, guessColumn(headers, MAT_SYNONYMS))
		populateSelect(colBatch, headers, guessColumn(headers, BATCH_SYNONYMS))
		parseHint.textContent = `Loaded ${rows.length} rows, ${headers.length} columns. Adjust the mapping above if it looks wrong.`
		mappingBlock.style.display = 'block'
	}

	function populateSelect(sel, hdrs, guessed) {
		sel.innerHTML = ''
		hdrs.forEach((h) => {
			const opt = document.createElement('option')
			opt.value = h
			opt.textContent = h
			sel.appendChild(opt)
		})
		if (guessed) sel.value = guessed
	}

	function handleFile(file) {
		fileNameEl.textContent = file.name
		const reader = new FileReader()
		reader.onload = function (e) {
			try {
				const data = new Uint8Array(e.target.result)
				workbook = XLSX.read(data, { type: 'array' })
				sheetNames = workbook.SheetNames
				sheetTabsEl.innerHTML = ''
				if (sheetNames.length > 1) {
					sheetNames.forEach((name) => {
						const tab = document.createElement('div')
						tab.className = 'sheet-tab'
						tab.dataset.sheet = name
						tab.textContent = name
						tab.onclick = () => loadSheet(name)
						sheetTabsEl.appendChild(tab)
					})
				}
				loadSheet(sheetNames[0])
			} catch (err) {
				parseHint.textContent = 'Could not parse this file: ' + err.message
				mappingBlock.style.display = 'none'
			}
		}
		reader.readAsArrayBuffer(file)
	}

	dropZone.addEventListener('click', () => fileInput.click())
	fileInput.addEventListener('change', (e) => {
		if (e.target.files.length) handleFile(e.target.files[0])
	})
	;['dragenter', 'dragover'].forEach((evt) =>
		dropZone.addEventListener(evt, (e) => {
			e.preventDefault()
			dropZone.classList.add('drag')
		}),
	)
	;['dragleave', 'drop'].forEach((evt) =>
		dropZone.addEventListener(evt, (e) => {
			e.preventDefault()
			dropZone.classList.remove('drag')
		}),
	)
	dropZone.addEventListener('drop', (e) => {
		if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0])
	})

	// ---------------------------------------------------------------------
	// Data model helpers
	// ---------------------------------------------------------------------
	function hashStr(s) {
		let h = 0x811c9dc5
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i)
			h = Math.imul(h, 0x01000193)
		}
		return (h >>> 0).toString(16)
	}
	function sanitizeId(raw) {
		const s = String(raw ?? '').trim()
		let cleaned = s.replace(/[^A-Za-z0-9_\-.~:@+]/g, '_').slice(0, 60)
		if (!cleaned) cleaned = 'bin'
		return cleaned + '_' + hashStr(s)
	}

	// Each source row = one pallet. Rows sharing the same bin + material +
	// batch are grouped into a single line and counted as palletCount.
	function buildBinsFromRows(binCol, matCol, batchCol) {
		const binMap = new Map()
		let skipped = 0
		rows.forEach((r) => {
			const bin = String(r[binCol] ?? '').trim()
			const mat = String(r[matCol] ?? '').trim()
			const batch = String(r[batchCol] ?? '').trim()
			if (!bin) {
				skipped++
				return
			}
			if (!binMap.has(bin)) binMap.set(bin, new Map())
			const lineMap = binMap.get(bin)
			const key = mat + '\u241F' + batch
			if (!lineMap.has(key))
				lineMap.set(key, { key, material: mat, batch: batch, palletCount: 0 })
			if (mat === '' || mat.toLowerCase() === '<<empty>>' || mat === '—') {
				lineMap.get(key).palletCount += 0
			} else {
				lineMap.get(key).palletCount += 1
			}
		})
		const bins = [...binMap.entries()]
			.map(([bin, lineMap]) => {
				const lines = [...lineMap.values()].sort(
					(a, b) =>
						b.palletCount - a.palletCount ||
						a.material.localeCompare(b.material),
				)
				return finalizeBin({ id: sanitizeId(bin), bin, lines })
			})
			.sort((a, b) => a.bin.localeCompare(b.bin, undefined, { numeric: true }))
		return { bins, skipped }
	}

	function finalizeBin(bin) {
		bin.totalPallets = bin.lines.reduce(
			(s, l) => s + (Number(l.palletCount) || 0),
			0,
		)
		return bin
	}

	// ---------------------------------------------------------------------
	// Persistence wiring
	// ---------------------------------------------------------------------
	async function loadAndRender() {
		const cfg = getGhConfig()
		statusDot.className = 'dot'
		statusText.textContent = cfg
			? 'Connecting to GitHub…'
			: 'Loading local data…'
		try {
			const saved = await Store.load()
			if (saved && Array.isArray(saved.bins) && saved.bins.length) {
				state.capacity = saved.capacity || 32
				state.bins = saved.bins.map(finalizeBin)
				state.fileName = saved.fileName || ''
				capacityInput.value = state.capacity
			}
			if (cfg) {
				statusDot.className = 'dot on'
				statusText.textContent =
					'Synced with GitHub — changes appear on every device using this repo.'
			} else if (saved) {
				statusDot.className = 'dot off'
				statusText.textContent =
					'Loaded saved data from this browser only. Connect GitHub above to sync across devices.'
			} else {
				statusDot.className = 'dot off'
				statusText.textContent =
					'No saved data yet — data is stored in this browser only until you connect GitHub.'
			}
		} catch (e) {
			console.error(e)
			statusDot.className = 'dot off'
			statusText.textContent =
				'Could not reach GitHub (' + e.message + '). Check the repo/token above.'
		}
		renderAll()
	}

	async function boot() {
		const cfg = getGhConfig()
		if (cfg) {
			ghRepo.value = cfg.owner + '/' + cfg.repo
			ghBranch.value = cfg.branch
			ghPath.value = cfg.path
			ghToken.value = cfg.token
			updateGhSummary(
				true,
				'Cloud sync (GitHub): ' + cfg.owner + '/' + cfg.repo + ' — click to edit',
			)
			ghSettings.open = false // already connected — keep the layout compact
		} else {
			updateGhSummary(false, 'Cloud sync (GitHub): not connected — click to set up')
			ghSettings.open = true // nothing configured yet — show the form
		}
		await loadAndRender()
		if (getGhConfig()) startGhPolling()
	}

	let persistQueue = Promise.resolve()
	function persist() {
		// Chain saves so only one write is ever in flight — clicking the
		// +/- buttons quickly no longer fires overlapping GitHub requests,
		// which was making transient network failures more likely.
		// pendingWrites also tells the poller to back off: otherwise a poll
		// landing between "I edited locally" and "the save finished" could
		// fetch the still-old remote copy and stomp the edit right back out.
		pendingWrites++
		persistQueue = persistQueue.then(persistOnce, persistOnce).finally(() => {
			pendingWrites = Math.max(0, pendingWrites - 1)
			if (pendingWrites === 0) ghPollOnce() // catch up on anything that arrived while we were busy saving
		})
		return persistQueue
	}
	async function persistOnce() {
		try {
			await Store.save({
				capacity: state.capacity,
				fileName: state.fileName,
				bins: state.bins,
				updatedAt: new Date().toISOString(),
			})
			if (getGhConfig()) {
				statusDot.className = 'dot on'
				statusText.textContent = 'Saved to GitHub.'
			}
		} catch (e) {
			console.error('persist failed', e)
			statusDot.className = 'dot off'
			statusText.textContent =
				'Could not save to GitHub (' + e.message + '). Your last change may not be synced.'
		}
	}

	// ---------------------------------------------------------------------
	// GitHub connect / disconnect
	// ---------------------------------------------------------------------
	ghConnectBtn.addEventListener('click', async () => {
		const repoVal = ghRepo.value.trim()
		const slash = repoVal.indexOf('/')
		const owner = slash > -1 ? repoVal.slice(0, slash).trim() : ''
		const repo = slash > -1 ? repoVal.slice(slash + 1).trim() : ''
		const token = ghToken.value.trim()
		if (!owner || !repo) {
			ghHint.className = 'hint error'
			ghHint.textContent =
				'Enter the repo as owner/name, e.g. yourname/bin-dashboard-data.'
			return
		}
		if (!token) {
			ghHint.className = 'hint error'
			ghHint.textContent = 'Personal access token is required.'
			return
		}
		setGhConfig({
			owner,
			repo,
			branch: ghBranch.value.trim() || 'main',
			path: ghPath.value.trim() || 'dataset.json',
			token,
		})
		ghSha = null
		ghEtag = null
		ghHint.className = 'hint'
		ghHint.textContent = 'Connecting…'
		await loadAndRender()
		if (getGhConfig()) {
			ghHint.textContent =
				'Connected. Repeat this setup (same repo + token) on your other devices to sync them.'
			updateGhSummary(true, 'Cloud sync (GitHub): ' + owner + '/' + repo + ' — click to edit')
			ghSettings.open = false
			startGhPolling()
		} else {
			ghHint.className = 'hint error'
		}
	})

	ghDisconnectBtn.addEventListener('click', async () => {
		clearGhConfig()
		stopGhPolling()
		ghSha = null
		ghEtag = null
		ghRepo.value = ''
		ghBranch.value = ''
		ghPath.value = ''
		ghToken.value = ''
		ghHint.className = 'hint'
		ghHint.textContent =
			'Disconnected. Data will now be saved to this browser only.'
		updateGhSummary(false, 'Cloud sync (GitHub): not connected — click to set up')
		ghSettings.open = true
		await loadAndRender()
	})

	// ---------------------------------------------------------------------
	// Generate dashboard
	// ---------------------------------------------------------------------
	processBtn.addEventListener('click', () => {
		const binCol = colBin.value,
			matCol = colMaterial.value,
			batchCol = colBatch.value
		const capacity = parseFloat(capacityInput.value) || 32
		if (!binCol || !matCol || !batchCol) {
			parseHint.className = 'hint error'
			parseHint.textContent =
				'Please map Storage Bin, Material and Batch first.'
			return
		}
		const { bins, skipped } = buildBinsFromRows(binCol, matCol, batchCol)
		state.capacity = capacity
		state.bins = bins
		state.fileName = fileNameEl.textContent || ''
		parseHint.className = 'hint'
		parseHint.textContent = skipped
			? `Dashboard generated (${skipped} rows skipped for missing a bin).`
			: 'Dashboard generated.'
		renderAll()
		persist()
		statusDot.className = 'dot on'
		statusText.textContent = 'Saved to this browser.'
	})

	capacityInput.addEventListener('change', () => {
		state.capacity = parseFloat(capacityInput.value) || 32
		renderAll()
		persist()
	})

	// ---------------------------------------------------------------------
	// Manual pallet count adjustment
	// ---------------------------------------------------------------------
	function adjustPalletCount(binId, lineKey, delta) {
		const bin = state.bins.find((b) => b.id === binId)
		if (!bin) return
		const line = bin.lines.find((l) => l.key === lineKey)
		if (!line) return
		line.palletCount = Math.max(
			0,
			Math.round((Number(line.palletCount) || 0) + delta),
		)
		finalizeBin(bin)
		renderAll()
		persist()
	}
	function initializeEmptyBin(binId, lineKey) {
		const bin = state.bins.find((b) => b.id === binId)
		if (!bin) return

		// 1. 弹出输入框让用户填写物料和批次
		const newMaterial = prompt('Enter Material Number for this bin:', '')
		if (!newMaterial || newMaterial.trim() === '') {
			alert('Material cannot be empty.')
			return
		}

		const newBatch = prompt('Enter Batch Number for this bin (Optional):', '—')
		const initialPallets = parseInt(
			prompt('Enter initial Pallets count:', '1'),
			10,
		)
		if (isNaN(initialPallets) || initialPallets < 1) {
			alert('Initial pallets must be at least 1.')
			return
		}

		// 2. 找到原本的 <<empty>> 占位行，将其替换为真正的物料数据
		const emptyLine = bin.lines.find((l) => l.key === lineKey)
		if (emptyLine) {
			emptyLine.material = newMaterial.trim()
			emptyLine.batch = newBatch.trim()
			emptyLine.palletCount = initialPallets

			// 更新这条记录的唯一 Key，防止后续冲突
			emptyLine.key = emptyLine.material + '\u241F' + emptyLine.batch
		}

		// 3. 重新计算并保存
		finalizeBin(bin)
		renderAll()
		persist()
	}
	// 将函数挂载到 window 作用域，确保 HTML 中的 onclick 能够正常调用
	window.__initializeEmptyBin = initializeEmptyBin

	function applyDelta(binId, lineKey, triggerEl, sign) {
		const wrap = triggerEl.closest('.qty-editor')
		const input = wrap.querySelector('.qty-delta')
		const val = parseFloat(input.value)
		if (isNaN(val) || val <= 0) {
			input.focus()
			return
		}
		adjustPalletCount(binId, lineKey, sign * val)
	}
	window.__applyDelta = applyDelta
	window.__deltaKeydown = function (ev, binId, lineKey) {
		if (ev.key === 'Enter') {
			ev.preventDefault()
			applyDelta(binId, lineKey, ev.target, 1)
		}
	}

	// ---------------------------------------------------------------------
	// Rendering
	// ---------------------------------------------------------------------
	function capState(count, capacity) {
		const pct = capacity > 0 ? count / capacity : 0
		if (pct > 1) return 'danger'
		if (pct >= 0.85) return 'warn'
		return 'ok'
	}
	function escapeHtml(s) {
		return String(s ?? '').replace(
			/[&<>"']/g,
			(c) =>
				({
					'&': '&amp;',
					'<': '&lt;',
					'>': '&gt;',
					'"': '&quot;',
					"'": '&#39;',
				})[c],
		)
	}

	// function palletEditorHtml(binId, lineKey, count) {
	// 	const safeBin = escapeHtml(binId),
	// 		safeKey = escapeHtml(lineKey)
	// 	return `
	//   <span class="qty-editor">
	//     <button type="button" onclick="window.__applyDelta('${safeBin}','${safeKey}', this, -1)" aria-label="Decrease">−</button>
	//     <span class="qty-val">${count}</span>
	//     <input type="number" class="qty-delta" min="0" step="1" placeholder="qty"
	//       onkeydown="window.__deltaKeydown(event,'${safeBin}','${safeKey}')">
	//     <button type="button" onclick="window.__applyDelta('${safeBin}','${safeKey}', this, 1)" aria-label="Increase">+</button>
	//   </span>`
	// }
	function palletEditorHtml(binId, lineKey, count) {
		const safeBin = escapeHtml(binId),
			safeKey = escapeHtml(lineKey)

		// 🟢 如果托盘数是 0（说明是 <<empty>> 行），渲染一个“初始化添加”按钮
		if (Number(count) === 0) {
			return `
      <span class="qty-editor">
        <button type="button" class="btn-init-add" style=" width: 100%;min-width: 120px; padding: 8px 16px; font-size: 12px; background: var(--accent); color: var(--accent-ink); border: none; border-radius: 4px; cursor: pointer; font-weight: 500;" onclick="window.__initializeEmptyBin('${safeBin}', '${safeKey}')">
          + Add Material
        </button>
      </span>`
		}

		// 正常的加减输入框保持不变
		return `
    <span class="qty-editor">
      <button type="button" onclick="window.__applyDelta('${safeBin}','${safeKey}', this, -1)" aria-label="Decrease">−</button>
      <span class="qty-val">${count}</span>
      <input type="number" class="qty-delta" min="0" step="1" placeholder="qty" onkeydown="window.__deltaKeydown(event,'${safeBin}','${safeKey}')">
      <button type="button" onclick="window.__applyDelta('${safeBin}','${safeKey}', this, 1)" aria-label="Increase">+</button>
    </span>`
	}

	function activeFilters() {
		return {
			mat: searchMaterial.value.trim().toLowerCase(),
			batch: searchBatch.value.trim().toLowerCase(),
			bin: searchBin.value.trim().toLowerCase(),
			onlyAvail: onlyAvailable.checked,
		}
	}

	function renderAll() {
		const hasData = state.bins && state.bins.length > 0
		emptyState.style.display = hasData ? 'none' : 'block'
		resultsHead.style.display = hasData ? 'block' : 'none'
		if (!hasData) {
			resultsList.innerHTML = ''
			statRow.style.display = 'none'
			return
		}

		const overCount = state.bins.filter(
			(b) => b.totalPallets > state.capacity,
		).length
		statBins.textContent = state.bins.length
		statLines.textContent = state.bins.reduce((s, b) => s + b.lines.length, 0)
		statOver.textContent = overCount
		statRow.style.display = 'flex'

		const f = activeFilters()
		const filterActive = !!(f.mat || f.batch || f.bin || f.onlyAvail)
		if (filterActive) {
			renderSearchResults(f)
		} else {
			searchNote.textContent = ''
			resultsTitle.textContent = `Bin detail (${state.bins.length} bins)`
			renderBinCards(state.bins)
		}
	}

	function renderBinCards(bins) {
		let html = ''
		bins.forEach((b) => {
			const st = capState(b.totalPallets, state.capacity)
			const pct =
				state.capacity > 0
					? Math.round((b.totalPallets / state.capacity) * 100)
					: 0
			const badgeText =
				st === 'danger' ? 'Over capacity' : st === 'warn' ? 'Nearly full' : 'OK'
			html += `
        <div class="bin-card">
          <div class="bin-top">
            <div class="bin-code">${escapeHtml(b.bin)}</div>
            <span class="badge ${st}">${badgeText}</span>
            <div class="bin-meta">
              <div class="m"><div class="n">${b.lines.length}</div><div class="l">Material/batch lines</div></div>
              <div class="m"><div class="n">${b.totalPallets} / ${state.capacity}</div><div class="l">Pallets used</div></div>
              <div class="capbar ${st}"><div class="track"><div class="fill" style="width:${Math.min(pct, 100)}%"></div></div><div class="pct">${pct}%</div></div>
            </div>
          </div>
          <table class="lines">
            <thead><tr><th class="mono">Material</th><th class="mono">Batch</th><th class="qtyh">Pallets</th></tr></thead>
            <tbody>
              ${b.lines
								.map(
									(l) => `
                <tr>
                  <td class="mono">${escapeHtml(l.material) || '—'}</td>
                  <td class="mono">${escapeHtml(l.batch) || '—'}</td>
                  <td class="qtycell">${palletEditorHtml(b.id, l.key, l.palletCount)}</td>
                </tr>`,
								)
								.join('')}
            </tbody>
          </table>
        </div>`
		})
		resultsList.innerHTML = html
	}

	function renderSearchResults(f) {
		const matches = []
		state.bins.forEach((b) => {
			if (f.bin && !b.bin.toLowerCase().includes(f.bin)) return
			if (f.onlyAvail && b.totalPallets >= state.capacity) return
			b.lines.forEach((l) => {
				if (f.mat && !l.material.toLowerCase().includes(f.mat)) return
				if (f.batch && !l.batch.toLowerCase().includes(f.batch)) return
				matches.push({ bin: b, line: l })
			})
		})
		resultsTitle.textContent = `Search results (${matches.length})`
		searchNote.textContent = matches.length
			? ''
			: 'No matching material / batch / bin.'
		if (matches.length === 0) {
			resultsList.innerHTML = ''
			return
		}
		matches.sort((a, b) =>
			a.bin.bin.localeCompare(b.bin.bin, undefined, { numeric: true }),
		)

		let html = `
      <div class="bin-card search-results">
        <table class="lines">
          <thead><tr><th class="mono">Bin</th><th class="mono">Material</th><th class="mono">Batch</th><th class="qtyh">Pallets</th><th>Bin usage</th></tr></thead>
          <tbody>
            ${matches
							.map(({ bin, line }) => {
								const pct =
									state.capacity > 0
										? Math.round((bin.totalPallets / state.capacity) * 100)
										: 0
								const st = capState(bin.totalPallets, state.capacity)
								return `
                <tr>
                  <td class="mono">${escapeHtml(bin.bin)}</td>
                  <td class="mono">${escapeHtml(line.material) || '—'}</td>
                  <td class="mono">${escapeHtml(line.batch) || '—'}</td>
                  <td class="qtycell">${palletEditorHtml(bin.id, line.key, line.palletCount)}</td>
                  <td><span class="badge ${st}">${bin.totalPallets}/${state.capacity} (${pct}%)</span></td>
                </tr>`
							})
							.join('')}
          </tbody>
        </table>
      </div>`
		resultsList.innerHTML = html
	}

	;[searchMaterial, searchBatch, searchBin].forEach((el) =>
		el.addEventListener('input', renderAll),
	)
	onlyAvailable.addEventListener('change', renderAll)

	// ---------------------------------------------------------------------
	// CSV export
	// ---------------------------------------------------------------------
	document.getElementById('exportBtn').addEventListener('click', () => {
		if (!state.bins.length) return
		const rowsOut = [
			[
				'Bin',
				'Material',
				'Batch',
				'Pallets',
				'Bin total pallets',
				'Capacity',
				'Status',
			],
		]
		state.bins.forEach((b) => {
			const st = capState(b.totalPallets, state.capacity)
			const stText =
				st === 'danger' ? 'Over capacity' : st === 'warn' ? 'Nearly full' : 'OK'
			b.lines.forEach((l) => {
				rowsOut.push([
					b.bin,
					l.material,
					l.batch,
					l.palletCount,
					b.totalPallets,
					state.capacity,
					stText,
				])
			})
		})
		const csv = rowsOut
			.map((r) =>
				r
					.map((v) => {
						const s = String(v)
						return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
					})
					.join(','),
			)
			.join('\n')
		const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = 'bin-storage-dashboard.csv'
		document.body.appendChild(a)
		a.click()
		document.body.removeChild(a)
		URL.revokeObjectURL(url)
	})

	// ---------------------------------------------------------------------
	// Boot
	// ---------------------------------------------------------------------
	boot()
})()
