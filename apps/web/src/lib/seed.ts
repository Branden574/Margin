import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont, type RGB } from 'pdf-lib';
import type { CoverStyle, DocumentRecord, FolderRecord } from '@margin/core';
import { isWorkspaceSeeded, seedSampleWorkspace } from './storage';

const ink = rgb(0.15, 0.22, 0.2);
const muted = rgb(0.44, 0.49, 0.46);
const line = rgb(0.82, 0.86, 0.82);
const palette = {
  biology: rgb(0.23, 0.42, 0.32),
  literature: rgb(0.48, 0.34, 0.42),
  math: rgb(0.33, 0.39, 0.58),
  notes: rgb(0.55, 0.4, 0.24),
};
type Fonts = { regular: PDFFont; bold: PDFFont; serif: PDFFont; italic: PDFFont };
type Book = { pdf: PDFDocument; fonts: Fonts; color: RGB; subject: string; title: string };

function text(
  page: PDFPage,
  value: string,
  x: number,
  y: number,
  font: PDFFont,
  size = 11,
  color = ink,
) {
  page.drawText(value, { x, y, font, size, color });
}
function paragraph(
  page: PDFPage,
  value: string,
  x: number,
  y: number,
  width: number,
  font: PDFFont,
  size = 11,
  leading = 17,
  color = ink,
): number {
  for (const raw of value.split('\n')) {
    let row = '';
    for (const word of raw.split(' ')) {
      const next = row ? `${row} ${word}` : word;
      if (row && font.widthOfTextAtSize(next, size) > width) {
        text(page, row, x, y, font, size, color);
        y -= leading;
        row = word;
      } else row = next;
    }
    if (row) text(page, row, x, y, font, size, color);
    y -= leading;
  }
  return y;
}
function rule(page: PDFPage, y: number, x = 48, width = 516) {
  page.drawLine({ start: { x, y }, end: { x: x + width, y }, color: line, thickness: 0.65 });
}
function writingLines(page: PDFPage, y: number, count = 3, x = 48, width = 516) {
  for (let index = 0; index < count; index++) rule(page, y - index * 25, x, width);
}
function question(
  book: Book,
  page: PDFPage,
  number: string,
  value: string,
  y: number,
  count = 3,
): number {
  text(page, number.padStart(2, '0'), 48, y, book.fonts.bold, 11, book.color);
  const bottom = paragraph(page, value, 78, y, 482, book.fonts.regular);
  writingLines(page, bottom - 13, count, 78, 486);
  return bottom - 13 - count * 25 - 22;
}
function callout(book: Book, page: PDFPage, title: string, value: string, y: number, height = 88) {
  page.drawRectangle({ x: 48, y: y - height, width: 516, height, color: rgb(0.95, 0.96, 0.94) });
  page.drawRectangle({ x: 48, y: y - height, width: 3, height, color: book.color });
  text(page, title.toUpperCase(), 66, y - 24, book.fonts.bold, 9, book.color);
  paragraph(page, value, 66, y - 44, 479, book.fonts.regular, 10, 15);
}
function page(book: Book, section: string): PDFPage {
  const sheet = book.pdf.addPage([612, 792]);
  const index = book.pdf.getPageCount();
  pageBackground(book, sheet, section, index);
  return sheet;
}
function pageBackground(book: Book, sheet: PDFPage, section: string, index: number) {
  sheet.drawRectangle({ x: 0, y: 781, width: 612, height: 11, color: book.color });
  text(sheet, 'MARGIN  /  ORIGINAL SAMPLE', 48, 752, book.fonts.bold, 8, book.color);
  text(sheet, book.subject.toUpperCase(), 420, 752, book.fonts.bold, 8, muted);
  text(sheet, book.title, 48, 705, book.fonts.serif, 27);
  text(sheet, section, 48, 677, book.fonts.regular, 11, muted);
  rule(sheet, 657);
  text(sheet, 'Name', 48, 636, book.fonts.regular, 9, muted);
  rule(sheet, 631, 80, 230);
  text(sheet, 'Date', 375, 636, book.fonts.regular, 9, muted);
  rule(sheet, 631, 403, 161);
  rule(sheet, 49);
  text(
    sheet,
    'Original practice material created for Margin. Editable local sample.',
    48,
    33,
    book.fonts.regular,
    7,
    muted,
  );
  text(sheet, String(index).padStart(2, '0'), 550, 33, book.fonts.bold, 9, book.color);
}
async function book(title: string, subject: string, color: RGB): Promise<Book> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setAuthor('Margin');
  pdf.setSubject('Original demonstration learning material');
  pdf.setProducer('Margin sample library');
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    serif: await pdf.embedFont(StandardFonts.TimesRoman),
    italic: await pdf.embedFont(StandardFonts.TimesRomanItalic),
  };
  return { pdf, fonts, title, subject, color };
}

async function biology() {
  const b = await book('Cell structure & function', 'Biology / Unit 02', palette.biology);
  let p = page(b, 'A closer look at the building blocks of life');
  callout(
    b,
    p,
    'Learning intention',
    'Connect the structure of a cell to the work it does. Use evidence from the diagram and the reading to explain your thinking.',
    603,
  );
  text(p, 'Inside an animal cell', 48, 487, b.fonts.serif, 19);
  p.drawEllipse({
    x: 296,
    y: 361,
    xScale: 131,
    yScale: 86,
    color: rgb(0.9, 0.94, 0.88),
    borderColor: b.color,
    borderWidth: 2,
  });
  p.drawEllipse({
    x: 293,
    y: 366,
    xScale: 42,
    yScale: 36,
    color: rgb(0.72, 0.82, 0.66),
    borderColor: b.color,
    borderWidth: 1,
  });
  p.drawEllipse({ x: 294, y: 365, xScale: 14, yScale: 12, color: rgb(0.45, 0.61, 0.39) });
  for (const [x, y, rotate] of [
    [210, 350, 0],
    [352, 390, 0],
    [346, 322, 0],
  ]) {
    void rotate;
    p.drawEllipse({
      x,
      y,
      xScale: 23,
      yScale: 10,
      color: rgb(0.84, 0.78, 0.54),
      borderColor: rgb(0.59, 0.5, 0.3),
      borderWidth: 1,
    });
    p.drawLine({
      start: { x: x - 14, y },
      end: { x: x + 14, y: y + 2 },
      color: rgb(0.59, 0.5, 0.3),
      thickness: 1,
    });
  }
  const label = (value: string, x: number, y: number, endX: number, endY: number) => {
    text(p, value, x, y, b.fonts.regular, 10, b.color);
    p.drawLine({
      start: { x: x < 250 ? x + 74 : x - 8, y: y + 3 },
      end: { x: endX, y: endY },
      color: muted,
      thickness: 0.7,
    });
  };
  label('Cell membrane', 51, 411, 178, 394);
  label('Cytoplasm', 53, 293, 216, 317);
  label('Nucleus', 462, 414, 314, 384);
  label('Mitochondrion', 459, 304, 362, 323);
  text(
    p,
    'Schematic only: organelles are not shown to scale.',
    161,
    251,
    b.fonts.italic,
    10,
    muted,
  );
  question(
    b,
    p,
    '1',
    'The cell membrane forms a boundary. Why must that boundary allow some substances to pass through?',
    216,
    4,
  );
  p = page(b, 'Read, connect, and explain');
  text(p, 'One cell, many connected jobs', 48, 593, b.fonts.serif, 21);
  let y = paragraph(
    p,
    'A cell is an organized living system. Its membrane separates its contents from the surroundings while regulating what enters and leaves. Inside, a fluid environment called cytoplasm supports chemical reactions and the movement of materials.',
    48,
    560,
    516,
    b.fonts.regular,
  );
  y = paragraph(
    p,
    'The nucleus holds most of the genetic instructions in an animal cell. These instructions help the cell make proteins. Mitochondria transfer energy from nutrients into forms the cell can use. A muscle cell, which does frequent work, often contains many mitochondria.',
    48,
    y - 16,
    516,
    b.fonts.regular,
  );
  y = question(
    b,
    p,
    '2',
    'Underline one sentence that links a cell structure with its function. Restate that connection in your own words.',
    y - 30,
    3,
  );
  y = question(
    b,
    p,
    '3',
    'Predict how a cell might be affected if its mitochondria could no longer function normally. Explain the reason for your prediction.',
    y,
    3,
  );
  question(
    b,
    p,
    '4',
    'A model leaves things out. Identify one limitation of the diagram on page 1.',
    y,
    2,
  );
  p = page(b, 'Apply your understanding');
  callout(
    b,
    p,
    'Compare two cells',
    'Cell A absorbs nutrients from the intestine. Cell B moves a limb by contracting. Both have a membrane, a nucleus, and mitochondria.',
    603,
    80,
  );
  let next = question(
    b,
    p,
    '5',
    'Which cell might need more mitochondria? State your claim and support it with reasoning.',
    492,
    4,
  );
  next = question(
    b,
    p,
    '6',
    'Draw a simple model of Cell A below. Label two structures and describe how each helps the cell do its work.',
    next,
    0,
  );
  p.drawRectangle({
    x: 78,
    y: 128,
    width: 486,
    height: Math.max(90, next - 137),
    borderColor: line,
    borderWidth: 1,
  });
  text(
    p,
    'Exit reflection: One question I still have about cells is...',
    48,
    99,
    b.fonts.italic,
    11,
  );
  rule(p, 77);
  return b.pdf;
}

async function literature() {
  const b = await book('The art of close reading', 'English / Workshop 03', palette.literature);
  let p = page(b, 'Notice the details. Follow the questions. Build an interpretation.');
  callout(
    b,
    p,
    'Reading focus',
    'Read the original passage twice. On your first reading, follow what happens. On your second, mark the words that shape mood and reveal a change.',
    603,
  );
  text(p, 'The last light in the greenhouse', 48, 483, b.fonts.serif, 21);
  let y = paragraph(
    p,
    'Every evening, Mara passed the greenhouse on her way home. Its windows wore a thin coat of dust, and the vines inside had begun to press against the glass. No one in the village remembered who had last turned the key.',
    48,
    451,
    516,
    b.fonts.serif,
    13,
    21,
  );
  y = paragraph(
    p,
    'On Thursday, a square of yellow light appeared at the far end. Mara stopped. Through the leaves, she could make out a pair of hands setting small pots in a row. The movements were slow and deliberate, as if each pot had a particular place in the world.',
    48,
    y - 12,
    516,
    b.fonts.serif,
    13,
    21,
  );
  y = paragraph(
    p,
    'The next morning, the door stood open. Beside it sat a tray of seedlings and a note: Take one. Leave room for another. Mara chose the smallest plant. For the rest of the walk, she carried it with both hands.',
    48,
    y - 12,
    516,
    b.fonts.serif,
    13,
    21,
  );
  text(
    p,
    'An original passage written for this practice worksheet.',
    48,
    y - 12,
    b.fonts.italic,
    10,
    muted,
  );
  question(
    b,
    p,
    '1',
    'Highlight a detail that suggests neglect and a detail that suggests care. What changes between them?',
    y - 47,
    3,
  );
  p = page(b, 'From observation to interpretation');
  y = question(
    b,
    p,
    '2',
    'The passage says the windows "wore a thin coat of dust." What effect does this description create?',
    597,
    4,
  );
  y = question(
    b,
    p,
    '3',
    'What do the slow, deliberate movements suggest about the unknown person? Quote a short phrase as evidence.',
    y,
    4,
  );
  y = question(
    b,
    p,
    '4',
    'Why might Mara choose the smallest plant? Develop one interpretation and explain how the final sentence supports it.',
    y,
    3,
  );
  callout(
    b,
    p,
    'A useful sentence frame',
    'The detail ______ suggests ______ because ______. A second detail that supports this interpretation is ______.',
    157,
    85,
  );
  p = page(b, 'Write a response');
  callout(
    b,
    p,
    'Writing invitation',
    'How does the greenhouse change in meaning across the passage? Write a paragraph with a clear claim, two specific details, and reasoning that connects them.',
    603,
    95,
  );
  writingLines(p, 472, 13);
  text(p, 'Before you finish', 48, 112, b.fonts.bold, 11, b.color);
  text(
    p,
    '[ ] I made a claim.    [ ] I used evidence.    [ ] I explained why the evidence matters.',
    48,
    87,
    b.fonts.regular,
    10,
  );
  return b.pdf;
}

async function mathematics() {
  const b = await book('Quadratic equations', 'Mathematics / Practice 04', palette.math);
  let p = page(b, 'Patterns, factors, and the shape of a solution');
  callout(
    b,
    p,
    "Today's toolkit",
    'A quadratic equation contains a squared variable. If a product equals zero, at least one of its factors must equal zero. Use this property to solve factorable quadratics.',
    603,
    94,
  );
  text(p, 'A worked example', 48, 477, b.fonts.serif, 21);
  const rows = [
    ['x^2 - 5x + 6 = 0', 'Start with the equation.'],
    ['(x - 2)(x - 3) = 0', 'Find two numbers with sum -5 and product 6.'],
    ['x - 2 = 0  or  x - 3 = 0', 'Apply the zero-product property.'],
    ['x = 2  or  x = 3', 'Check each value in the original equation.'],
  ];
  rows.forEach(([equation, explanation], index) => {
    text(p, equation, 66, 441 - index * 43, b.fonts.bold, 13, b.color);
    text(p, explanation, 284, 441 - index * 43, b.fonts.regular, 9);
    rule(p, 425 - index * 43, 66, 480);
  });
  let y = question(
    b,
    p,
    '1',
    'Solve x^2 - 7x + 12 = 0. Show the factorization and both solutions.',
    236,
    3,
  );
  question(
    b,
    p,
    '2',
    'Explain why dividing both sides of x(x - 4) = 0 by x would lose a solution.',
    y,
    2,
  );
  p = page(b, 'Practice with purpose');
  y = question(
    b,
    p,
    '3',
    'Solve x^2 + 2x - 15 = 0. Substitute each answer to check your work.',
    596,
    4,
  );
  y = question(b, p, '4', 'Solve 2x^2 - 8x = 0. Begin by identifying a common factor.', y, 4);
  y = question(
    b,
    p,
    '5',
    'A rectangle has width x and length x + 3. Its area is 40 square units. Write an equation, solve it, and explain which solution is valid.',
    y,
    4,
  );
  text(
    p,
    'Challenge: create a quadratic equation whose solutions are -2 and 5.',
    48,
    120,
    b.fonts.italic,
    12,
  );
  writingLines(p, 91, 1);
  p = page(b, 'Connect an equation to its graph');
  text(p, 'Explore y = x^2 - 4', 48, 593, b.fonts.serif, 21);
  const left = 149,
    bottom = 308,
    step = 33;
  for (let i = 0; i <= 8; i++) {
    p.drawLine({
      start: { x: left + i * step, y: bottom },
      end: { x: left + i * step, y: bottom + 8 * step },
      color: line,
      thickness: 0.5,
    });
    p.drawLine({
      start: { x: left, y: bottom + i * step },
      end: { x: left + 8 * step, y: bottom + i * step },
      color: line,
      thickness: 0.5,
    });
  }
  p.drawLine({
    start: { x: left + 4 * step, y: bottom },
    end: { x: left + 4 * step, y: bottom + 8 * step },
    color: b.color,
    thickness: 1.3,
  });
  p.drawLine({
    start: { x: left, y: bottom + 4 * step },
    end: { x: left + 8 * step, y: bottom + 4 * step },
    color: b.color,
    thickness: 1.3,
  });
  text(p, 'x', 425, 442, b.fonts.italic, 12);
  text(p, 'y', 289, 579, b.fonts.italic, 12);
  text(
    p,
    'Each square represents one unit. Plot values for x = -2, -1, 0, 1, 2.',
    95,
    285,
    b.fonts.regular,
    10,
  );
  y = question(
    b,
    p,
    '6',
    'Where does the graph cross the x-axis? How does that relate to solving x^2 - 4 = 0?',
    250,
    3,
  );
  question(b, p, '7', 'How would adding 2 to every y-value change the graph?', y, 2);
  return b.pdf;
}

async function notes() {
  const b = await book('Weekly lesson planner', 'Teaching / Planning', palette.notes);
  let p = page(b, 'A little structure. Plenty of room to think.');
  text(p, 'This week, learners will...', 48, 594, b.fonts.serif, 20);
  writingLines(p, 563, 3);
  const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
  days.forEach((day, index) => {
    const top = 464 - index * 72;
    p.drawRectangle({
      x: 48,
      y: top - 56,
      width: 516,
      height: 61,
      borderColor: line,
      borderWidth: 0.75,
    });
    text(p, day, 60, top - 13, b.fonts.bold, 8, b.color);
    text(p, 'Focus / activity / evidence of learning', 161, top - 13, b.fonts.italic, 10, muted);
    rule(p, top - 42, 161, 388);
  });
  p = page(b, 'Plan for the learners in front of you');
  let y = question(
    b,
    p,
    '1',
    'Prior knowledge: What do learners already know, and how will I find out?',
    592,
    4,
  );
  y = question(
    b,
    p,
    '2',
    'Access and support: What choices, scaffolds, or alternative formats will help learners participate?',
    y,
    4,
  );
  y = question(b, p, '3', 'Evidence: What will I look for or listen for during the lesson?', y, 4);
  text(p, 'After the lesson: what I will keep, change, or try next', 48, 116, b.fonts.italic, 12);
  writingLines(p, 91, 1);
  return b.pdf;
}

async function ecology() {
  const b = await book('Water & living systems', 'Biology / Field Notes', palette.biology);
  let p = page(b, 'Observe carefully. Record what you can support.');
  callout(
    b,
    p,
    'Field question',
    'How does the availability of water affect the living things in a small outdoor area? Compare two safe, accessible observation sites without disturbing organisms.',
    603,
    91,
  );
  let y = question(
    b,
    p,
    '1',
    'Describe Site A and Site B. Include shade, surface material, and any visible signs of moisture.',
    475,
    4,
  );
  y = question(
    b,
    p,
    '2',
    'Record three observations at each site. Separate what you see from what you infer.',
    y,
    5,
  );
  question(b, p, '3', 'Which conditions might explain the differences you observed?', y, 2);
  p = page(b, 'Make a claim and name its limits');
  y = question(
    b,
    p,
    '4',
    'Write a claim about the relationship between moisture and the organisms you observed. Include two observations as evidence.',
    594,
    5,
  );
  y = question(
    b,
    p,
    '5',
    'What else could explain your observations? Identify a factor you did not measure.',
    y,
    4,
  );
  question(
    b,
    p,
    '6',
    'Plan a follow-up observation. What would you keep the same, and what would you compare?',
    y,
    4,
  );
  return b.pdf;
}

let seedPromise: Promise<void> | undefined;
export function seedWorkspace(): Promise<void> {
  if (!seedPromise)
    seedPromise = initialize().catch((error) => {
      seedPromise = undefined;
      throw error;
    });
  return seedPromise;
}
async function initialize() {
  if (await isWorkspaceSeeded()) return;
  const folders: FolderRecord[] = [
    { id: 'folder-biology', name: 'Biology', color: '#6b9276' },
    { id: 'folder-literature', name: 'English literature', color: '#b28b9c' },
    { id: 'folder-math', name: 'Mathematics', color: '#8197bf' },
  ];
  const definitions: {
    id: string;
    name: string;
    folderId: string | null;
    cover: CoverStyle;
    create: () => Promise<PDFDocument>;
  }[] = [
    {
      id: 'sample-cell-structure',
      name: 'Cell structure & function',
      folderId: 'folder-biology',
      cover: 'biology',
      create: biology,
    },
    {
      id: 'sample-close-reading',
      name: 'The art of close reading',
      folderId: 'folder-literature',
      cover: 'literature',
      create: literature,
    },
    {
      id: 'sample-quadratics',
      name: 'Quadratic equations',
      folderId: 'folder-math',
      cover: 'math',
      create: mathematics,
    },
    {
      id: 'sample-weekly-planner',
      name: 'Weekly lesson planner',
      folderId: null,
      cover: 'notes',
      create: notes,
    },
    {
      id: 'sample-water-systems',
      name: 'Water & living systems',
      folderId: 'folder-biology',
      cover: 'biology',
      create: ecology,
    },
  ];
  const now = Date.now();
  const documents = [];
  for (const [index, definition] of definitions.entries()) {
    const pdf = await definition.create();
    const blob = new Blob([new Uint8Array(await pdf.save())], { type: 'application/pdf' });
    const record: DocumentRecord = {
      id: definition.id,
      name: definition.name,
      mimeType: 'application/pdf',
      size: blob.size,
      pageCount: pdf.getPageCount(),
      createdAt: now - index * 3_600_000,
      updatedAt: now - index * 3_600_000,
      folderId: definition.folderId,
      starred: index === 0,
      trashed: false,
      cover: definition.cover,
      source: 'sample',
    };
    documents.push({ record, blob });
  }
  await seedSampleWorkspace(folders, documents);
}
