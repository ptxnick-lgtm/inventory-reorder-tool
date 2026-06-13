import React from "react";

export const metadata = {
  title: "Inventory Reorder Tool",
  description: "Upload an inventory export and get a sorted reorder list.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Rye&family=Special+Elite&display=swap"
          rel="stylesheet"
        />
        <style>{`
          h1.western { font-family: 'Rye', 'Special Elite', serif; font-weight: 400; letter-spacing: .5px; }
          h2, h3 { font-family: 'Special Elite', Georgia, serif; }
          body { background-image: repeating-linear-gradient(0deg, rgba(120,72,40,.03) 0 1px, transparent 1px 28px); }
        `}</style>
      </head>
      <body
        style={{
          margin: 0,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          background: "#e8dcc0",
          color: "#3a2a1a",
        }}
      >
        {children}
      </body>
    </html>
  );
}
