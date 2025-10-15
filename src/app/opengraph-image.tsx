import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'gitweb - Transform repositories into visual art';
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = 'image/png';

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#000',
          padding: '80px',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '40px',
          }}
        >
          <div
            style={{
              fontSize: '120px',
              fontWeight: '300',
              letterSpacing: '0.025em',
              color: '#fff',
              display: 'flex',
            }}
          >
            git
            <span style={{ fontWeight: '200', opacity: 0.6 }}>web</span>
          </div>

          <div
            style={{
              fontSize: '40px',
              color: 'rgba(255, 255, 255, 0.6)',
              fontWeight: '300',
              textAlign: 'center',
            }}
          >
            Transform repositories into visual art
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
