'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSession, signIn, signOut } from 'next-auth/react';
import { Loader2, Linkedin } from 'lucide-react';
import GraphVisualization from '@/components/GraphVisualization';
import TrendingSection from '@/components/TrendingSection';

interface ProgressData {
  message: string;
  filesAnalyzed?: number;
  totalFiles?: number;
}

export default function Home() {
  const { data: session } = useSession();
  const [repoUrl, setRepoUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [graphData, setGraphData] = useState(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<ProgressData | string | null>(null);

  const analyzeRepo = async (overrideRepoUrl?: string) => {
    const urlToUse = overrideRepoUrl || repoUrl;
    if (!urlToUse.trim()) return;

    if (!session) {
      signIn('google');
      return;
    }

    setLoading(true);
    setError('');
    setGraphData(null);

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: urlToUse }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to start analysis');
      }

      const { sessionId: newSessionId } = await response.json();

      const pollInterval = setInterval(async () => {
        try {
          const progressResponse = await fetch(`/api/analyze?sessionId=${newSessionId}`);

          if (!progressResponse.ok) {
            clearInterval(pollInterval);
            setError('Failed to check progress');
            setLoading(false);
            setProgress(null);
            return;
          }

          const progressData = await progressResponse.json();

          if (progressData.progress === 'completed') {
            clearInterval(pollInterval);
            setGraphData(progressData.result);
            setLoading(false);
            setProgress(null);
          } else if (progressData.progress === 'error') {
            clearInterval(pollInterval);
            setError(progressData.error || 'Analysis failed');
            setLoading(false);
            setProgress(null);
          } else {
            // Update progress
            setProgress(progressData.progress);
          }
        } catch (err) {
          clearInterval(pollInterval);
          setError('Failed to check progress');
          setLoading(false);
          setProgress(null);
        }
      }, 500); // Poll every 500ms for more responsive updates

    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'black', color: 'white' }}>
      {!graphData && (
        <div style={{
          position: 'fixed',
          top: '1rem',
          right: '1rem',
          zIndex: 50
        }}>
          {session ? (
            <button
              onClick={() => signOut()}
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                color: 'white',
                padding: '0.5rem 1rem',
                borderRadius: '0.5rem',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                fontSize: '0.875rem',
                fontWeight: '500',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLElement).style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLElement).style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
              }}
            >
              Sign Out
            </button>
          ) : (
            <button
              onClick={() => signIn('google')}
              style={{
                background: 'linear-gradient(135deg, rgba(102, 126, 234, 0.8) 0%, rgba(118, 75, 162, 0.8) 100%)',
                color: 'white',
                padding: '0.5rem 1rem',
                borderRadius: '0.5rem',
                border: 'none',
                fontSize: '0.875rem',
                fontWeight: '500',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLElement).style.backgroundColor = '#3367d6';
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLElement).style.backgroundColor = '#4285f4';
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24">
                <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
              Sign In
            </button>
          )}
        </div>
      )}

      <AnimatePresence mode="wait">
        {!graphData ? (
          <motion.div
            key="landing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              minHeight: '100vh',
              padding: '4rem',
              display: 'flex',
              flexDirection: 'column',
              width: '100%',
              gap: '1rem',
              alignItems: 'start',
            }}
            className="mobile-responsive-padding"
          >
            {/* Main Content */}
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.2 }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                width: '100%',
                alignItems: 'center',
                paddingTop: '4rem',
                paddingBottom: '0rem'
              }}
              className="mobile-responsive-content"
            >
              <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '3rem' }}>
                <h1 style={{
                  fontSize: '3.75rem',
                  fontWeight: '300',
                  letterSpacing: '0.025em',
                  lineHeight: '1'
                }}>
                  git<span style={{ fontWeight: '200', opacity: 0.6 }}>web</span>
                </h1>
                <p style={{
                  color: 'rgba(255, 255, 255, 0.6)',
                  fontSize: '1.125rem',
                  fontWeight: '300'
                }}>
                  Transform repositories into visual art
                </p>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '40rem', width: '100%' }}>
                <input
                  type="text"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && analyzeRepo()}
                  placeholder="https://github.com/owner/repo"
                  style={{
                    width: '100%',
                    backgroundColor: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '0.5rem',
                    padding: '1.5rem',
                    color: 'white',
                    fontSize: '1.125rem',
                    fontWeight: '300',
                    outline: 'none',
                    transition: 'border-color 0.2s'
                  }}
                  onFocus={(e) => e.target.style.borderColor = 'rgba(255, 255, 255, 0.3)'}
                  onBlur={(e) => e.target.style.borderColor = 'rgba(255, 255, 255, 0.1)'}
                  disabled={loading}
                />

                {error && (
                  <motion.p
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    style={{
                      color: '#ef4444',
                      fontSize: '0.875rem',
                      fontWeight: '300'
                    }}
                  >
                    {error}
                  </motion.p>
                )}

                <button
                  onClick={() => analyzeRepo()}
                  disabled={loading || !repoUrl.trim()}
                  style={{
                    width: '100%',
                    backgroundColor: 'white',
                    color: 'black',
                    padding: '1rem',
                    borderRadius: '0.5rem',
                    fontSize: '1.125rem',
                    fontWeight: '300',
                    border: 'none',
                    outline: 'none',
                    cursor: loading || !repoUrl.trim() ? 'not-allowed' : 'pointer',
                    opacity: loading || !repoUrl.trim() ? 0.3 : 1,
                    transition: 'background-color 0.2s'
                  }}
                  onMouseEnter={(e) => !loading && repoUrl.trim() && ((e.target as HTMLElement).style.backgroundColor = 'rgba(255, 255, 255, 0.9)')}
                  onMouseLeave={(e) => !loading && repoUrl.trim() && ((e.target as HTMLElement).style.backgroundColor = 'white')}
                >
                  {loading ? (
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                      <Loader2 className="animate-spin" size={20} />
                      Analyzing...
                    </span>
                  ) : (
                    'Visualize'
                  )}
                </button>

                {/* Progress Bar */}
                {loading && progress && (
                  <div style={{
                    width: '100%',
                    marginTop: '1rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem'
                  }}>
                    <div style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: '0.875rem',
                      color: 'rgba(255, 255, 255, 0.7)'
                    }}>
                      <span>
                        {typeof progress === 'object' && progress.message 
                          ? progress.message 
                          : typeof progress === 'string' 
                          ? progress 
                          : 'Analyzing...'}
                      </span>
                      {typeof progress === 'object' && progress.filesAnalyzed !== undefined && progress.totalFiles !== undefined && (
                        <span>{progress.filesAnalyzed}/{progress.totalFiles}</span>
                      )}
                    </div>
                    {typeof progress === 'object' && progress.filesAnalyzed !== undefined && progress.totalFiles !== undefined && progress.totalFiles > 0 && (
                      <div style={{
                        width: '100%',
                        height: '0.5rem',
                        backgroundColor: 'rgba(255, 255, 255, 0.1)',
                        borderRadius: '0.25rem',
                        overflow: 'hidden'
                      }}>
                        <div style={{
                          height: '100%',
                          backgroundColor: 'white',
                          width: `${(progress.filesAnalyzed / progress.totalFiles) * 100}%`,
                          transition: 'width 0.3s ease-out',
                          borderRadius: '0.25rem'
                        }} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </motion.div>

            <motion.div
              initial={{ x: 20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ delay: 0.4 }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                width: '100%',
              }}
            >
              <TrendingSection onRepoSelect={(repoUrl) => {
                setRepoUrl(repoUrl);
                window.scrollTo({ top: 0, behavior: 'smooth' });
                analyzeRepo(repoUrl);
              }} />
            </motion.div>
          </motion.div>
        ) : (
          <motion.div
            key="visualization"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{ height: '100vh' }}
          >
            <GraphVisualization
              data={graphData}
              repoUrl={repoUrl}
              onBack={() => setGraphData(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {!graphData && (
        <footer style={{
          marginTop: '4rem',
          padding: '2rem 0',
          borderTop: '1px solid rgba(255, 255, 255, 0.1)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center'
        }}>
          <div style={{ display: 'flex', gap: '2rem' }}>
            <a
              href="https://www.rickycheuk.com"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: 'rgba(255, 255, 255, 0.6)',
                textDecoration: 'none',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '2.5rem',
                height: '2.5rem',
                borderRadius: '0.5rem',
                backgroundColor: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.1)'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
                e.currentTarget.style.color = 'white';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
                e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)';
              }}
            >
              <img src="/myweb.webp" alt="My Website" width="20" height="20" style={{ objectFit: 'contain' }} />
            </a>

            <a
              href="https://linkedin.com/in/rickycheuk"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: 'rgba(255, 255, 255, 0.6)',
                textDecoration: 'none',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '2.5rem',
                height: '2.5rem',
                borderRadius: '0.5rem',
                backgroundColor: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.1)'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
                e.currentTarget.style.color = 'white';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
                e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)';
              }}
            >
              <Linkedin size={20} />
            </a>

            <a
              href="https://buymeacoffee.com/rickycheuk"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: '#FFD700',
                textDecoration: 'none',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '2.5rem',
                height: '2.5rem',
                borderRadius: '0.5rem',
                backgroundColor: 'rgba(255, 215, 0, 0.1)',
                border: '1px solid rgba(255, 215, 0, 0.3)'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(255, 215, 0, 0.2)';
                e.currentTarget.style.color = '#FFE55C';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(255, 215, 0, 0.1)';
                e.currentTarget.style.color = '#FFD700';
              }}
            >
              <img src="/bmac.gif" alt="Buy me a coffee" width="20" height="20" style={{ objectFit: 'contain' }} />
            </a>
          </div>
        </footer>
      )}
    </div>
  );
}
