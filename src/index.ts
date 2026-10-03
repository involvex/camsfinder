#!/usr/bin/env bun
import {sleep} from 'bun'
import hasFlag from 'has-flag'
import {cpSync, existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {chromium, type Page} from 'playwright'

// Default Chrome user data dir (so the existing profile/cookies are reused)
const local_app_data = process.env.LOCALAPPDATA ?? ''
const home_dir = process.env.HOME ?? ''
const chrome_user_data_dir =
	local_app_data.length > 0
		? path.join(local_app_data, 'Google', 'Chrome', 'User Data')
		: path.join(home_dir, '.config', 'google-chrome')

// The real profile cannot be used directly: it is locked by the running Chrome
// ("Opened in an existing browser session" -> "Target page, context or browser has been closed").
// So we copy the *whole* user data dir (Local State + every profile + the installed extensions
// and their settings) into a private, throw-away user data dir, which is unlocked again.
// Copying only the profile folder is not enough: the extensions are enabled through
// "Local State" + the profile's "Preferences"/"Secure Preferences".
const profile_name = process.env.CHROME_PROFILE ?? 'Default'
const user_data_dir = path.join(tmpdir(), 'camsfinder-chrome')
const lock_files = [
	'SingletonLock',
	'SingletonCookie',
	'SingletonSocket',
	'lockfile',
]
// Big/useless folders (caches, crash dumps) - skipping them keeps the copy fast
const skip_dirs = new Set([
	'Crashpad',
	'CrashpadMetrics',
	'Crash Reports',
	'component_crx_cache',
	'component_updater',
	'ShaderCache',
	'GrShaderCache',
	'GraphiteDawnCache',
	'DawnCache',
	'DawnGraphiteCache',
	'DawnWebGPUCache',
	'GPUCache',
	'Cache',
	'Code Cache',
	'blob_storage',
	'Service Worker',
	'OptimizationGuidePredictionModels',
	'Safe Browsing',
	'BrowserMetrics',
	'segmentation_platform',
	'component_crx_cache'.toUpperCase(),
])

function prepareUserDataDir(): string {
	if (!existsSync(chrome_user_data_dir)) {
		console.warn(
			`Chrome user data dir not found (${chrome_user_data_dir}), using a fresh profile`,
		)
		rmSync(user_data_dir, {recursive: true, force: true})
		mkdirSync(user_data_dir, {recursive: true})
		return user_data_dir
	}

	if (!existsSync(path.join(chrome_user_data_dir, profile_name))) {
		console.warn(
			`Profile "${profile_name}" not found in ${chrome_user_data_dir}`,
		)
	}

	// Always start from a clean copy, so we never keep stale or half-written data
	rmSync(user_data_dir, {recursive: true, force: true})
	mkdirSync(user_data_dir, {recursive: true})

	console.log(
		`Copying Chrome user data (${chrome_user_data_dir}) into ${user_data_dir}...`,
	)
	try {
		cpSync(chrome_user_data_dir, user_data_dir, {
			recursive: true,
			force: true,
			filter: src => {
				const base = path.basename(src)
				// Skip the lock files of the running Chrome (root, profile and leveldb ones)
				return (
					!lock_files.includes(base) && base !== 'LOCK' && !skip_dirs.has(base)
				)
			},
		})
	} catch (error) {
		console.warn(
			'Could not copy the Chrome user data dir, continuing with what was copied:',
			error,
		)
	}

	// The copy must never look "locked" to the new instance
	for (const lock of lock_files) {
		rmSync(path.join(user_data_dir, lock), {force: true})
		rmSync(path.join(user_data_dir, profile_name, lock), {force: true})
	}
	return user_data_dir
}

type ModelRow = {name: string; url: string; age: string; country: string}

// Renders the models exactly like `console.table` (index + columns, padded and
// aligned), but as plain text, so the whole listing can be written to a file.
function formatModelsTable(models: ModelRow[]): string {
	const columns = ['name', 'url', 'age', 'country'] as const
	const indexHeader = ''
	const rows = models.map((model, index) =>
		[String(index), model.name, model.url, model.age, model.country].map(
			value => String(value ?? ''),
		),
	)

	// The index column is right aligned, every other column is left aligned
	const align = (value: string, width: number, right: boolean) =>
		right ? value.padStart(width) : value.padEnd(width)
	const widths = rows.reduce<number[]>(
		(acc, row) => row.map((cell, i) => Math.max(acc[i] ?? 0, cell.length)),
		[indexHeader.length, ...columns.map(c => c.length)],
	)
	const line = (left: string, mid: string, right: string) =>
		left + widths.map(w => '─'.repeat(w + 2)).join(mid) + right
	const renderRow = (row: string[], right: boolean[] = []) =>
		'│ ' +
		widths
			.map((w, i) => align(row[i] ?? '', w, right[i] ?? false))
			.join(' │ ') +
		' │'

	return [
		line('┌', '┬', '┐'),
		renderRow([indexHeader, ...columns]),
		line('├', '┼', '┤'),
		...rows.map(row => renderRow(row, [true])),
		line('└', '┴', '┘'),
	].join('\n')
}

async function extractModelUrls(url: string) {
	// Launch the locally installed Chrome (default chrome.exe) with a copy of the user data dir
	const context = await chromium.launchPersistentContext(prepareUserDataDir(), {
		channel: 'chrome',
		headless: false,
		viewport: null,
		// Playwright starts Chromium with --disable-extensions, so the extensions of the
		// copied profile would never be loaded. Remove that default arg to keep them.
		ignoreDefaultArgs: ['--disable-extensions'],
		args: [
			`--profile-directory=${profile_name}`,
			'--no-first-run',
			'--no-default-browser-check',
			'--start-maximized',
		],
	})
	// The persistent context always starts with an extra "about:blank" tab.
	// Reuse it, but make sure we never stay on the blank page.
	let page: Page = context.pages()[0] ?? (await context.newPage())
	for (const extra of context.pages()) {
		if (extra !== page) {
			await extra.close().catch(() => {})
		}
	}
	page.setDefaultTimeout(60000)
	page.setDefaultNavigationTimeout(120000)

	try {
		console.log(`Navigating to ${url}...`)
		const response = await page.goto(url, {waitUntil: 'domcontentloaded'})
		console.log(
			`Loaded: ${page.url()} (status: ${response?.status() ?? 'n/a'})`,
		)
		if (page.url() === 'about:blank') {
			console.warn('Still on about:blank, retrying in a fresh page...')
			page = await context.newPage()
			page.setDefaultTimeout(60000)
			page.setDefaultNavigationTimeout(120000)
			await page.goto(url, {waitUntil: 'domcontentloaded'})
			console.log(`Loaded: ${page.url()}`)
		}
		await page.waitForLoadState('networkidle').catch(() => {})
		await sleep(1000)
		// The age gate is skipped silently when it is not shown (e.g. already accepted)
		await page
			.getByText('I am 18 or older')
			.click({timeout: 15000})
			.catch(() => {
				console.log('No age gate found, continuing...')
			})
		await sleep(10000)
		// Wait for the listing grid (the container holding the model cards) to be rendered
		const gridSelector = '.listing-grid-transition .grid.gap-4'
		await page.waitForSelector(gridSelector)
		// The cards are rendered lazily (content-visibility), so make sure they really have content
		await page.waitForFunction(
			selector =>
				document.querySelectorAll(`${selector} a[href^="/model/"]`).length > 0,
			gridSelector,
		)

		// Extract the data from the page context
		const models = await page.evaluate(selector => {
			type Model = {name: string; url: string; age: string; country: string}
			const data: Model[] = []
			const seen = new Set<string>()

			// Every direct child of the grid is a card (some are wrapped in a
			// "content-visibility: auto" placeholder div, so go one level deeper).
			const cards = document.querySelectorAll(
				`${selector} > div, ${selector} > div > div`,
			)

			for (const card of cards) {
				// A card contains exactly one model link; pick the deepest one
				// (the "info bar" link, which holds the username as text)
				const links = Array.from(
					card.querySelectorAll<HTMLAnchorElement>('a[href^="/model/"]'),
				).filter(a => a.getAttribute('href'))
				// `at()` can be undefined (e.g. with noUncheckedIndexedAccess)
				const link = links.at(-1)
				if (!link) {
					continue
				}
				const href = link.getAttribute('href') ?? ''
				// Prevent duplicates (the thumbnail and the info bar share the same href)
				if (!href || seen.has(href)) {
					continue
				}
				seen.add(href)

				// The name is the text of the info bar link, e.g. "_meganmeow_"
				const name =
					(link.textContent ?? '').trim() || href.split('/').pop() || ''

				// The info bar also holds the age and the country flag
				const card_ = link.closest('div')?.parentElement?.parentElement ?? card
				const age =
					Array.from(card_.querySelectorAll('span'))
						.map(s => s.textContent?.trim() ?? '')
						.find(t => /^\d{2}$/.test(t)) ?? ''
				const flag = card_.querySelector('img[alt^="Flag of"]')
				const country = flag?.getAttribute('alt')?.replace('Flag of ', '') ?? ''

				data.push({
					name,
					url: `https://www.camsfinder.com${href}`,
					age,
					country,
				})
			}

			return data
		}, gridSelector)

		console.log(`Found ${models.length} models:`)
		console.table(models)
		// Write the whole listing (the same table as in the console) to the result file
		writeFileSync('result.txt', formatModelsTable(models), 'utf8')
	} catch (error) {
		console.error('Error extracting URLs:', error)
	} finally {
		await context.close()
	}
}

let targetUrl =
	process.env.TARGET_URL || 'https://www.camsfinder.com/girl/chaturbate'
if (hasFlag('--url')) {
	// `--url <value>`: read the value that follows the flag
	const value = process.argv[process.argv.indexOf('--url') + 1]
	if (value && !value.startsWith('--')) {
		targetUrl = value
	} else {
		console.warn('--url was given without a value, keeping', targetUrl)
	}
}
extractModelUrls(targetUrl)
