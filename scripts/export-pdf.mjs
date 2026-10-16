// Example usage: node scripts/export-pdf.mjs output/pdfs/Govinda-Ram-Pingali-Resume-2026-10-16.pdf

// Run outside the agent sandbox: node scripts/export-pdf.mjs
// Uses Chrome's PDF engine directly, rather than macOS's Quartz print dialog.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyPdf } from './verify-pdf.mjs';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(projectDirectory, process.argv[2] || 'output/pdfs/Govinda-Ram-Pingali-Resume-Chrome.pdf');
const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await access(executablePath);
try {
    await access(outputPath);
    throw new Error(`Output already exists; choose a new filename: ${outputPath}`);
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}

const profileDirectory = await mkdtemp(resolve(tmpdir(), 'resume-pdf-'));
const browserProcess = spawn(executablePath, [
    '--headless', '--remote-debugging-pipe', '--no-first-run',
    `--user-data-dir=${profileDirectory}`,
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let diagnostics = '';
browserProcess.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
let messageSequence = 0;
let incoming = '';
const pending = new Map();
const eventWaiters = new Set();
const decoder = new StringDecoder('utf8');
let browserError;
function rejectPending(error) {
    browserError = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    for (const waiter of eventWaiters) waiter.reject(error);
    eventWaiters.clear();
}
browserProcess.on('error', rejectPending);
const browserClosed = new Promise(resolveClosed => browserProcess.once('close', resolveClosed));
browserProcess.on('exit', (code, signal) => rejectPending(new Error(`Chrome exited (${signal || code}) before completing the export. ${diagnostics}`)));
browserProcess.stdio[3].on('error', rejectPending);
browserProcess.stdio[4].on('data', chunk => {
    incoming += decoder.write(chunk);
    let boundary;
    while ((boundary = incoming.indexOf('\0')) !== -1) {
        const packet = incoming.slice(0, boundary);
        incoming = incoming.slice(boundary + 1);
        if (!packet) continue;
        const message = JSON.parse(packet);
        for (const waiter of eventWaiters) {
            if (message.method === waiter.method && message.sessionId === waiter.sessionId) {
                eventWaiters.delete(waiter);
                waiter.resolve(message.params);
            }
        }
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
    }
});
function send(method, parameters = {}, sessionId) {
    return new Promise((resolveRequest, rejectRequest) => {
        if (browserError) return rejectRequest(browserError);
        const id = ++messageSequence;
        const timeout = setTimeout(() => {
            pending.delete(id);
            rejectRequest(new Error(`Timed out: ${method}. ${diagnostics}`));
        }, 30000);
        pending.set(id, {
            resolve: value => { clearTimeout(timeout); resolveRequest(value); },
            reject: error => { clearTimeout(timeout); rejectRequest(error); },
        });
        browserProcess.stdio[3].write(JSON.stringify({ id, method, params: parameters, sessionId }) + '\0');
    });
}

function waitForEvent(method, sessionId) {
    return new Promise((resolveEvent, rejectEvent) => {
        if (browserError) return rejectEvent(browserError);
        const waiter = {
            method, sessionId,
            resolve: value => { clearTimeout(timeout); resolveEvent(value); },
            reject: error => { clearTimeout(timeout); rejectEvent(error); },
        };
        const timeout = setTimeout(() => {
            eventWaiters.delete(waiter);
            rejectEvent(new Error(`Timed out waiting for ${method}. ${diagnostics}`));
        }, 30000);
        eventWaiters.add(waiter);
    });
}

try {
    await send('Browser.getVersion');
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const command = (method, parameters) => send(method, parameters, sessionId);
    await command('Page.enable');
    await command('Emulation.setEmulatedMedia', { media: 'print' });
    // Subscribe before navigation: evaluating immediately can hit about:blank.
    await Promise.all([
        waitForEvent('Page.loadEventFired', sessionId),
        command('Page.navigate', { url: pathToFileURL(resolve(projectDirectory, 'govinda-resume-2026.html')).href })
            .then(result => { if (result.errorText) throw new Error(result.errorText); }),
    ]);
    const { result, exceptionDetails } = await command('Runtime.evaluate', {
        expression: `(async () => {
            if (document.readyState !== 'complete') await new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
            await document.fonts.ready;
            // Google Fonts declares unused Unicode subsets which correctly stay unloaded.
            // Require the faces actually used by this resume, not every declared subset.
            const requiredFonts = ['300 16px Montserrat', '400 16px Montserrat', '400 16px "Open Sans"', '600 16px "Open Sans"'];
            for (const font of requiredFonts) {
                const faces = await document.fonts.load(font, document.body.innerText);
                if (!faces.length || faces.some(face => face.status !== 'loaded')) {
                    throw new Error('Required font did not load: ' + font + '. Check the fonts/ folder and CSS section 0.');
                }
            }
            await Promise.all([...document.images].map(async image => {
                if (!image.complete) await image.decode();
                if (!image.naturalWidth) throw new Error('Image failed to load: ' + image.src);
            }));
            if (document.documentElement.dataset.debugLayout === 'true') throw new Error('Disable debug layout before exporting.');
            const sheets = [...document.querySelectorAll('.document_page')];
            if (sheets.length !== 2) throw new Error('Expected two resume sheets.');
            return sheets.map((sheet, index) => {
                const footer = sheet.querySelector('.document_footer').getBoundingClientRect();
                const entries = [...sheet.querySelectorAll('.main-column_experience-entry, .aux-column .document_section')];
                if (!entries.length) throw new Error('No content found on page ' + (index + 1));
                const remaining = Math.min(...entries.map(entry => footer.top - entry.getBoundingClientRect().bottom));
                if (remaining < -0.5) throw new Error('Content overlaps footer on page ' + (index + 1));
                return { page: index + 1, footerClearancePixels: Math.round(remaining * 10) / 10 };
            });
        })()`,
        awaitPromise: true,
        returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    console.log('Layout check:', result.value);
    const { data } = await command('Page.printToPDF', {
        printBackground: true,
        displayHeaderFooter: false,
        preferCSSPageSize: true,
        generateTaggedPDF: true,
        generateDocumentOutline: true,
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(data, 'base64'), { flag: 'wx' });
    console.log(`Saved ${outputPath}`);
    try {
        const { failures } = await verifyPdf(outputPath);
        if (failures.length) process.exitCode = 1;
    } catch (error) {
        console.error('PDF saved, but verification could not finish:', error.message);
        console.error('Verification requires Poppler (pdfinfo, pdffonts, pdftotext).');
        process.exitCode = 1;
    }
} finally {
    browserProcess.kill();
    // Wait for profile writers to exit before deleting the temporary directory.
    const killTimeout = setTimeout(() => browserProcess.kill('SIGKILL'), 5000);
    await browserClosed;
    clearTimeout(killTimeout);
    await rm(profileDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
