import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "./providers";

export const metadata: Metadata = {
  title: "gitweb · Transform Repos into Visual Art",
  description: "Transform any GitHub repository into beautiful, interactive visualizations. Explore code relationships as art with AI-powered insights.",
  keywords: ["github", "visualization", "code", "repository", "graph", "interactive", "react flow", "code analysis"],
  authors: [{ name: "Ricky Cheuk", url: "https://rickycheuk.com" }],
  creator: "Ricky Cheuk",
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://gitweb.app",
    siteName: "gitweb",
    title: "gitweb · Transform Repos into Visual Art",
    description: "Transform any GitHub repository into beautiful, interactive visualizations. Explore code relationships as art with AI-powered insights.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "gitweb - Transform repositories into visual art",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "gitweb · Transform Repos into Visual Art",
    description: "Transform any GitHub repository into beautiful, interactive visualizations.",
    creator: "@rickycheuk",
    images: ["/og-image.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
    ],
  },
  metadataBase: new URL(process.env.NEXTAUTH_URL || 'http://localhost:3000'),
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
