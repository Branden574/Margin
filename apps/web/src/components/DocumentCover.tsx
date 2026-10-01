import type { DocumentRecord } from '@margin/core';
import { FileText, ArrowUpRight } from 'lucide-react';
export function DocumentCover({
  document: doc,
  small = false,
}: {
  document: DocumentRecord;
  small?: boolean;
}) {
  return (
    <div
      className={`document-cover cover-${doc.cover} ${small ? 'cover-small' : ''}`}
      aria-hidden="true"
    >
      {doc.cover === 'biology' ? (
        <>
          <div className="cover-topline">
            BIOLOGY <span>01 / EXPLORING LIFE</span>
          </div>
          <div className="cover-title">
            Small cells.
            <br />
            Big discoveries.
          </div>
          <svg className="cell-art" viewBox="0 0 230 110" fill="none">
            <path
              d="M31 29C47 5 79 10 104 6s43 11 69 18 36 27 22 46-35 29-61 27-40 13-64 3-69-35-39-71Z"
              fill="#e2edb9"
              stroke="#596b38"
              strokeWidth="1.3"
            />
            <path
              d="M39 35C53 16 84 20 105 15s40 14 65 17 29 22 16 34-32 25-54 22-44 12-64 2-50-33-29-55Z"
              stroke="#839552"
              strokeWidth=".8"
            />
            <ellipse cx="104" cy="52" rx="24" ry="21" fill="#abbe78" stroke="#596b38" />
            <ellipse cx="110" cy="50" rx="8" ry="9" fill="#718646" />
            <path
              d="m148 41 13-9 15 10-15 9-13-10Zm-92 7 11-8 9 9-10 7-10-8Zm86 29 12-9 9 6-11 9-10-6Z"
              stroke="#657c3c"
              fill="#c6d796"
            />
            {[40, 54, 71, 141, 161, 174, 132, 88].map((x, i) => (
              <circle key={x} cx={x} cy={28 + (i % 4) * 16} r="2" fill="#657c3c" />
            ))}
            <path d="M97 78c4-9 8 7 12-2s8 6 12-3" stroke="#657c3c" />
          </svg>
        </>
      ) : doc.cover === 'literature' ? (
        <>
          <div className="cover-topline">
            ENGLISH LITERATURE <span>READING NOTES</span>
          </div>
          <div className="cover-title">
            Between
            <br />
            <em>the lines.</em>
          </div>
          <div className="book-art">
            <div />
            <div />
          </div>
          <div className="cover-caption">A guide to the art of close reading</div>
        </>
      ) : doc.cover === 'math' ? (
        <>
          <div className="cover-topline">
            MATHEMATICS <span>WORKSHEET 04</span>
          </div>
          <div className="cover-title">
            A new angle.
            <br />A fresh solution.
          </div>
          <svg className="graph-art" viewBox="0 0 200 120" fill="none">
            <defs>
              <pattern id={`grid-${doc.id}`} width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#a7bfce" strokeWidth=".5" />
              </pattern>
            </defs>
            <rect width="200" height="120" fill={`url(#grid-${doc.id})`} />
            <path d="M100 7v109M4 83h192" stroke="#597b90" />
            <path d="M35 6Q100 169 166 6" stroke="#547c97" strokeWidth="2" />
            <circle cx="100" cy="86" r="4" fill="#547c97" />
            <text x="144" y="110" fontSize="11" fill="#547c97" fontFamily="serif">
              y = x²
            </text>
          </svg>
        </>
      ) : doc.cover === 'notes' ? (
        <>
          <div className="cover-topline">
            THE TEACHER'S DESK <span>WEEKLY PLANNER</span>
          </div>
          <div className="cover-title">
            A little room
            <br />
            for good ideas.
          </div>
          <div className="planner-art">
            {['M', 'T', 'W', 'T', 'F'].map((d, i) => (
              <div key={i}>
                <b>{d}</b>
                <i />
                <i />
                <i />
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="cover-topline">
            YOUR DOCUMENT <span>PDF</span>
          </div>
          <div className="generic-paper">
            <FileText size={26} strokeWidth={1} />
            <strong>{doc.name.replace(/\.pdf$/i, '')}</strong>
            <i />
            <i />
            <i />
          </div>
        </>
      )}
      {!small && (
        <div className="cover-open">
          <ArrowUpRight size={18} />
        </div>
      )}
    </div>
  );
}
