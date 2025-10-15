'use client';

import { useState, useEffect } from 'react';

interface TrendingRepo {
  repoUrl: string;
  repoName: string;
  owner: string;
  repo: string;
  requestCount: number;
  lastRequestedAt: Date;
  imageUrl: string | null;
}

interface TrendingData {
  period: string;
  trending: TrendingRepo[];
}

interface TrendingSectionProps {
  onRepoSelect?: (repoUrl: string) => void;
}

export default function TrendingSection({ onRepoSelect }: TrendingSectionProps = {}) {
  const [dailyTrending, setDailyTrending] = useState<TrendingRepo[]>([]);
  const [weeklyTrending, setWeeklyTrending] = useState<TrendingRepo[]>([]);
  const [monthlyTrending, setMonthlyTrending] = useState<TrendingRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'daily' | 'weekly' | 'monthly'>('weekly');

  useEffect(() => {
    const fetchTrending = async () => {
      try {
        const [dailyRes, weeklyRes, monthlyRes] = await Promise.all([
          fetch('/api/trending?period=daily'),
          fetch('/api/trending?period=weekly'),
          fetch('/api/trending?period=monthly'),
        ]);

        const [dailyData, weeklyData, monthlyData] = await Promise.all([
          dailyRes.json(),
          weeklyRes.json(),
          monthlyRes.json(),
        ]);

        setDailyTrending(dailyData.trending || []);
        setWeeklyTrending(weeklyData.trending || []);
        setMonthlyTrending(monthlyData.trending || []);
      } catch (error) {
        console.error('Failed to fetch trending data:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchTrending();
  }, []);

  const getCurrentTrending = () => {
    switch (activeTab) {
      case 'daily':
        return dailyTrending;
      case 'weekly':
        return weeklyTrending;
      case 'monthly':
        return monthlyTrending;
    }
  };

  if (loading) {
    return (
      <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '0.5rem', padding: '1rem', maxWidth: '40rem', margin: '0 auto',
              display: 'flex',
              flexDirection: 'column',
              width: '100%', }}>
        <h2 style={{ fontSize: '1.5rem', fontWeight: '300', marginBottom: '1rem', color: 'white', textAlign: 'center' }}>Trending Repositories</h2>
        <div className="animate-pulse space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-8 bg-gray-700 rounded"></div>
          ))}
        </div>
      </div>
    );
  }

  const currentTrending = getCurrentTrending();

  return (
    <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '0.5rem', padding: '1rem', maxWidth: '40rem', margin: '0 auto',
              display: 'flex',
              flexDirection: 'column',
              width: '100%', }}>
      <h2 style={{ fontSize: '1.5rem', fontWeight: '300', marginBottom: '1rem', color: 'white', textAlign: 'center' }}>Trending Repositories</h2>

      {/* Tab Navigation */}
      <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '1.5rem', backgroundColor: 'rgba(255, 255, 255, 0.05)', padding: '0.25rem', borderRadius: '0.5rem' }}>
        {[
          { key: 'daily', label: 'Daily' },
          { key: 'weekly', label: 'Weekly' },
          { key: 'monthly', label: 'Monthly' },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key as typeof activeTab)}
            style={{
              flex: 1,
              padding: '0.5rem 1rem',
              borderRadius: '0.375rem',
              fontSize: '0.875rem',
              fontWeight: '500',
              transition: 'all 0.2s',
              backgroundColor: activeTab === tab.key ? 'rgba(255, 255, 255, 0.1)' : 'transparent',
              color: activeTab === tab.key ? 'white' : 'rgba(255, 255, 255, 0.6)',
              border: 'none',
              outline: 'none',
              cursor: 'pointer'
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Trending List */}
      <div className="space-y-2">
        {currentTrending.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2rem 0', color: 'rgba(255, 255, 255, 0.5)', fontSize: '0.875rem' }}>
            No trending repositories for this period yet.
          </div>
        ) : (
          currentTrending.map((repo, index) => (
            <div
              key={repo.repoUrl}
              style={{
                padding: '0.75rem',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '0.5rem',
                transition: 'background-color 0.2s'
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.05)'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            >
              {/* Mobile-first responsive layout */}
              <style jsx>{`
                @media (max-width: 640px) {
                  .trending-item {
                    padding: 0.5rem !important;
                  }
                  .repo-name {
                    font-size: 0.9rem !important;
                    line-height: 1.3 !important;
                    margin-bottom: 0.5rem !important;
                  }
                  .repo-preview {
                    width: 100% !important;
                    height: 120px !important;
                    margin-right: 0 !important;
                    margin-top: 0.5rem !important;
                  }
                  .repo-header {
                    display: flex !important;
                    justify-content: space-between !important;
                    align-items: flex-start !important;
                    margin-bottom: 0.5rem !important;
                  }
                  .repo-info {
                    display: flex !important;
                    align-items: center !important;
                    gap: 0.5rem !important;
                  }
                  .desktop-layout {
                    display: none !important;
                  }
                  .mobile-layout {
                    display: block !important;
                  }
                }
                @media (min-width: 641px) {
                  .mobile-layout {
                    display: none !important;
                  }
                }
              `}</style>

              {/* Desktop layout: Repo name on top, image and count below */}
              <div className="desktop-layout">

                {/* Preview and count underneath */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div
                        onClick={() => onRepoSelect?.(repo.repoUrl)} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
                    {repo.imageUrl && (
                      <img
                        src={repo.imageUrl}
                        alt={`${repo.repoName} graph preview`}
                        style={{
                          width: '120px',
                          height: '90px',
                          objectFit: 'cover',
                          borderRadius: '0.25rem',
                          marginRight: '0.75rem',
                          border: '1px solid rgba(255, 255, 255, 0.2)',
                          backgroundColor: 'rgba(0, 0, 0, 0.5)'
                        }}
                        onError={(e) => {
                          // Hide broken images
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    )}
                <div
                  onClick={() => onRepoSelect?.(repo.repoUrl)}
                  style={{
                    fontWeight: '500',
                    color: 'white',
                    cursor: 'pointer',
                    transition: 'color 0.2s',
                    marginBottom: '0.5rem',
                    wordBreak: 'break-word',
                    overflowWrap: 'break-word',
                    hyphens: 'auto',
                    width: '100%'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.color = 'rgba(59, 130, 246, 0.8)'}
                  onMouseLeave={(e) => e.currentTarget.style.color = 'white'}
                >
                  {repo.repoName}
                </div>

                    <a
                      href={repo.repoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        color: 'rgba(255, 255, 255, 0.6)',
                        transition: 'color 0.2s',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '0.5rem'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.color = 'rgba(59, 130, 246, 0.8)'}
                      onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)'}
                      title="View on GitHub"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                      </svg>
                    </a>
                  </div>
                  <div style={{ fontSize: '0.875rem', fontWeight: '500', color: 'rgba(255, 255, 255, 0.7)' }}>
                    {repo.requestCount}
                  </div>
                </div>
              </div>

              {/* Mobile layout: Repo name + info on same line, full-width image below */}
              <div className="mobile-layout">
                {/* Repo name and info on same line for mobile */}
                <div className="repo-header">
                  <div
                    className="repo-name"
                    onClick={() => onRepoSelect?.(repo.repoUrl)}
                    style={{
                      fontWeight: '500',
                      color: 'white',
                      cursor: 'pointer',
                      transition: 'color 0.2s',
                      wordBreak: 'break-word',
                      overflowWrap: 'break-word',
                      hyphens: 'auto',
                      flex: 1
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.color = 'rgba(59, 130, 246, 0.8)'}
                    onMouseLeave={(e) => e.currentTarget.style.color = 'white'}
                  >
                    {repo.repoName}
                  </div>

                  {/* GitHub link and count on right */}
                  <div className="repo-info">
                    <a
                      href={repo.repoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        color: 'rgba(255, 255, 255, 0.6)',
                        transition: 'color 0.2s',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.color = 'rgba(59, 130, 246, 0.8)'}
                      onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)'}
                      title="View on GitHub"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                      </svg>
                    </a>
                    <div style={{ fontSize: '0.875rem', fontWeight: '500', color: 'rgba(255, 255, 255, 0.7)' }}>
                      {repo.requestCount}
                    </div>
                  </div>
                </div>

                {/* Full-width image below */}
                {repo.imageUrl && (
                  <img
                    src={repo.imageUrl}
                    alt={`${repo.repoName} graph preview`}
                    className="repo-preview"
                    style={{
                      width: '120px',
                      height: '90px',
                      objectFit: 'cover',
                      borderRadius: '0.25rem',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      backgroundColor: 'rgba(0, 0, 0, 0.5)',
                      cursor: 'pointer'
                    }}
                    onClick={() => onRepoSelect?.(repo.repoUrl)}
                    onError={(e) => {
                      // Hide broken images
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                )}
              </div>
            </div>
          ))
        )}
      </div>


    </div>
  );
}