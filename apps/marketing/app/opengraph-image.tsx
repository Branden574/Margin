import { ImageResponse } from 'next/og';
export const alt = 'Margin — Make room for better documents.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 70,
          background: '#f6f4ef',
          color: '#242622',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ fontSize: 45, fontWeight: 700, color: '#b64f37' }}>margin.</div>
        <div
          style={{
            fontSize: 80,
            lineHeight: 1.06,
            letterSpacing: -5,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <span>Your documents.</span>
          <span>Finally, room to think.</span>
        </div>
        <div style={{ fontSize: 22, color: '#656a61' }}>
          A thoughtful document workspace · local edition
        </div>
      </div>
    ),
    size,
  );
}
