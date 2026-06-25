import React from "react";

export const metadata = {
  title: "Inventory Reorder Tool",
  description: "Upload an inventory export and get a sorted reorder list.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{`
          ::selection { background: #2b6cb0; color: #fff; }
          input::placeholder { color: #aaa; }
        `}</style>
      </head>
      <body
        style={{
          margin: 0,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          background: "#f6f7f9",
          color: "#1a1a1a",
        }}
      >
        {children}
      </body>
    </html>
  );
}
