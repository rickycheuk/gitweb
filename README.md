# gitweb

Transform repositories into visual art


## 🚀 Tech Stack That Slaps

- **Next.js 15** - Because we like living on the edge (with Turbopack!)
- **React Flow** - Graph visualization that feels like butter
- **Framer Motion** - Animations so smooth they're illegal in 3 states
- **OpenAI GPT-4** - The brain behind the beauty
- **MongoDB Atlas** - Where the analytics live
- **AWS S3** - Preview image storage
- **NextAuth** - Google OAuth for the VIP experience
- **Prisma** - Type-safe database queries
- **Tailwind CSS** - Utility-first styling
- **Babel Parser** - Code analysis wizardry
- **Dagre** - Graph layout algorithm

## 🎯 Quick Start

```bash
# Clone this
git clone https://github.com/yourusername/gitweb.git
cd gitweb

# Install packages
npm install

# Set up your environment
cp .env.example .env
# Add your OpenAI API key, MongoDB connection string, AWS credentials

# Fire it up!
npm run dev

# Visit http://localhost:3000 and prepare to be amazed
```

## 🎮 How to Use

1. **Drop that URL**: Paste any public GitHub repository
2. **Sign in**: Quick Google OAuth (we need to remember your masterpieces)
3. **Watch the magic**: gitweb clones, analyzes, and visualizes
4. **Explore**: 
   - Zoom with your scroll wheel
   - Pan by dragging

## 🔮 Under the Hood

1. **Clone**: Repository downloaded to `.gitweb-cache/repos`
2. **Analyze**: AI-powered code structure analysis
3. **Parse**: Babel for JS/TS, regex patterns for Python
4. **Extract**:
   - File dependencies from imports
   - Function declarations and calls
   - Class structures and methods
5. **Visualize**: React Flow + Dagre = Interactive graph art
6. **Generate**: OpenAI creates a beautiful preview image

## 💬 Supported Languages

gitweb analyzes code structure and relationships across **40+ programming languages**:

### Tier 1: Full AST Parsing
- **JavaScript/TypeScript** - Deep analysis with Babel Parser
- **Python** - Function, class, and import detection

### Tier 2: Regex-Based Analysis
All languages below support import/dependency tracking, function/class detection:

**Systems Programming**
- C/C++ (.c, .cpp, .cc, .cxx, .h, .hpp)
- Rust (.rs)
- Go (.go)
- Zig (.zig)

**JVM Ecosystem**
- Java (.java)
- Kotlin (.kt, .kts)
- Scala (.scala)
- Groovy (.groovy)
- Clojure (.clj, .cljs, .cljc)

**Mobile**
- Swift (.swift)
- Objective-C (.m, .mm)
- Dart (.dart) - Flutter apps
- Kotlin (.kt) - Android

**Web & Frontend**
- Vue (.vue)
- Svelte (.svelte)
- Astro (.astro)

**Scripting**
- Ruby (.rb, .rake)
- PHP (.php, .phtml)
- Perl (.pl, .pm)
- Lua (.lua)
- Shell (.sh, .bash, .zsh, .fish)

**.NET**
- C# (.cs)
- F# (.fs)
- Visual Basic (.vb)

**Data Science**
- R (.r, .R)
- Julia (.jl)
- SQL (.sql)

**Functional**
- Haskell (.hs)
- OCaml (.ml, .mli)
- Elixir (.ex, .exs)
- Erlang (.erl)

**Other**
- Nim (.nim)
- V (.v)
- Solidity (.sol) - Smart contracts

> **Note:** JavaScript/TypeScript get the royal treatment with full AST parsing for precise function calls and relationships. Other languages use pattern matching for solid structural analysis.

## 🏗️ Architecture

```
src/
├── app/
│   ├── page.tsx                    # Landing page magic
│   ├── layout.tsx                  # Root layout
│   ├── api/
│   │   ├── analyze/                # Main analysis endpoint
│   │   ├── trending/               # Trending repos API
│   │   ├── generate-preview/       # Preview image generation
│   │   └── auth/                   # NextAuth handlers
│   └── auth/signin/                # Sign-in page
├── components/
│   ├── GraphVisualization.tsx      # Graph renderer
│   └── TrendingSection.tsx         # Trending showcase
├── lib/
│   ├── analyzer.ts                 # Repo cloning & analysis
│   ├── parser.ts                   # Code parsing (Babel)
│   ├── layout.ts                   # Graph layout (Dagre)
│   ├── llm.ts                      # OpenAI integration
│   ├── graphPreview.ts             # Preview generation
│   └── s3.ts                       # AWS S3 storage
└── prisma/
    └── schema.prisma               # Database schema
```

## 🎨 Environment Variables

```env
# Database
DATABASE_URL="your-mongodb-atlas-connection-string"

# OpenAI
OPENAI_API_KEY="sk-..."

# NextAuth
NEXTAUTH_SECRET="your-secret-key"
NEXTAUTH_URL="http://localhost:3000"

# Google OAuth
GOOGLE_CLIENT_ID="your-client-id"
GOOGLE_CLIENT_SECRET="your-client-secret"

# AWS S3 (for preview images)
AWS_ACCESS_KEY_ID="your-access-key"
AWS_SECRET_ACCESS_KEY="your-secret-key"
AWS_S3_BUCKET_NAME="your-bucket-name"
AWS_REGION="us-east-1"
```

## 🌟 Features in the Wild

- **Trending Repos**: Browse daily, weekly, and monthly trending visualizations
- **Smart Caching**: Repositories are cached for instant re-analysis
- **Preview Images**: Auto-generated graph previews stored in S3
- **Analytics**: Track popular repositories and usage patterns
- **Private Repo Detection**: Politely tells you when a repo is private
- **Error Handling**: Graceful failures with helpful messages


## 🤝 Contributing

Found a bug? Have an idea? Want to add support for your favorite language?

1. Fork it
2. Create your feature branch (`git checkout -b feature/amazing`)
3. Commit your changes (`git commit -m 'Add something amazing'`)
4. Push to the branch (`git push origin feature/amazing`)
5. Open a Pull Request

## 📝 License

MIT License - Go wild, build amazing things!

## 💝 Built with Vibe

Vibed coded by [Ricky Cheuk](https://rickycheuk.com)

- 🌐 [Website](https://rickycheuk.com)
- 💼 [LinkedIn](https://linkedin.com/in/rickycheuk)
- ☕ [Buy me a coffee](https://buymeacoffee.com/rickycheuk)

---

**gitweb** - Because your code deserves to be seen as art ✨

