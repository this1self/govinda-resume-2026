// Requires Poppler: pdfinfo, pdffonts, pdftotext. No PDF is modified.
// Usage: node scripts/verify-pdf.mjs path/to/resume.pdf
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const anchors = [
    'CONTACT', 'SKILLS', 'WORK EXPERIENCE', 'TECHNOLOGY & INDUSTRY',
    'Apple Inc.', 'Cupertino, CA · 2022–2025',
    'Orgona', 'Remote · 2020–2022',
    'Apple Inc.', 'Cupertino, CA · 2016–2019',
    'SoundFocus', 'San Francisco, CA · 2014–2016',
    'EDUCATION', 'Master of Science in Music', 'Georgia Institute of',
    'Aug 2012–May 2014', 'Bachelor of Engineering in', 'R.V. College of Engineering',
    'Sep 2008–May 2012', 'COURSES', 'Sound Journey Facilitation',
    'SVARAM', 'Auroville, India', 'January 2026', 'Singing Bowl Mastery:',
    'iChakras', 'Spring 2024', 'Permaculture Design', 'Santa Cruz Permaculture',
    'Apr–Sep 2023', 'LINKS', 'govindarampingali.com',
    'WORK EXPERIENCE · CONTINUED', 'PERMACULTURE & FARM PRACTICE',
    "Palette o' Green 'n Red", 'Helped develop and manage',
    'Part-time / Remote · 2022–Present', 'Run the farm website',
    'Full-time / On-site · 2019–2022', 'Built and maintained',
    'The Becoming Festival', 'PGR Farm · December 2025', 'Produced and hosted',
    'MUSIC & CREATIVE PRACTICE', 'Elektric Body',
    'San Francisco, CA · May–August 2026', 'Composed, recorded',
    'Circus & Strings', 'San Francisco, CA · 2024–2026', 'Played covers',
    'Travelling Waves', 'Remote · 2016–Present', 'Built an iPad',
];
const normalize = text => text.replace(/\s+/gu, ' ').trim();

function checkOrder(text) {
    const normalized = normalize(text);
    let cursor = 0;
    for (const anchor of anchors) {
        const index = normalized.indexOf(anchor, cursor);
        if (index < 0) return `Missing or out of order: ${anchor}`;
        cursor = index + anchor.length;
    }
    return null;
}

export async function verifyPdf(path) {
    const commands = [
        ['pdfinfo', [path]], ['pdffonts', [path]],
        ['pdftotext', ['-raw', path, '-']],
        ['pdfinfo', ['-struct-text', path]],
        ['pdftotext', [path, '-']],
    ];
    const results = await Promise.all(commands.map(async ([command, args]) => {
        return execute(command, args, { maxBuffer: 8 * 1024 * 1024 });
    }));
    const [info, fonts, raw, structure, plain] = results.map(result => result.stdout);
    const failures = [];
    if (!/^Pages:\s+2\s*$/m.test(info)) failures.push('Expected exactly two PDF pages.');
    if (!/^Tagged:\s+yes\s*$/m.test(info)) failures.push('PDF is not tagged.');
    if (!/^Page size:\s+612 x 792 pts/m.test(info)) failures.push('Expected US Letter paper.');
    const fontRows = fonts.trim().split('\n').slice(2);
    if (!fontRows.length || fontRows.some(row => !/\byes\s+yes\s+yes\s+\d+\s+\d+\s*$/.test(row))) {
        failures.push('Some fonts lack embedding, subsetting, or Unicode maps.');
    }
    results.forEach((result, index) => {
        if (result.stderr.trim()) failures.push(`${commands[index][0]}: ${result.stderr.trim()}`);
    });
    for (const [label, text] of [['Raw reading order', raw], ['Tagged reading order', structure]]) {
        const error = checkOrder(text);
        if (error) failures.push(`${label}: ${error}`);
    }
    for (const phrase of ['ENGINEER · MUSICIAN · FARM MANAGER', '"Siri"-only', 'this-ego']) {
        if (!normalize(plain).includes(phrase)) failures.push(`Text integrity: missing ${phrase}`);
    }
    const geometryWarning = checkOrder(plain);
    console.log('PDF verification:');
    if (failures.length) failures.forEach(message => console.error(`  FAIL: ${message}`));
    else console.log('  PASS: two Letter pages, tagged structure, font maps, text integrity, raw and tagged reading order.');
    if (geometryWarning) console.warn(`  POSITION-BASED EXTRACTION: ${geometryWarning}`);
    else console.log('  PASS: position-based extraction also preserves the checked order.');
    console.log('  Visual review of both pages is still required. These checks do not certify every ATS.');
    return { failures, geometryWarning };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (!process.argv[2]) throw new Error('Usage: node scripts/verify-pdf.mjs path/to/resume.pdf');
    const { failures } = await verifyPdf(resolve(process.argv[2]));
    if (failures.length) process.exitCode = 1;
}
