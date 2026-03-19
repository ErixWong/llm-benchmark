# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.3] - 2026-03-13

### Added
- **Input File Support**: Token speed test now supports custom input text files
  - `--input-file` parameter to specify a text file as input
  - Accurate token counting for input text using gpt-tokenizer
  - Multiple sample files in `data/` directory (sample-8k.txt, etc.)

### Fixed
- **Token Speed Test**: Fixed 0 TPS issue with Qwen models
  - Added support for `delta.reasoning` field in streaming responses
  - Qwen models use `reasoning` instead of `content` for thinking tokens

### Changed
- [`src/token-speed.js`](src/token-speed.js): Added `inputText` parameter support
- [`tests/token-speed.test.js`](tests/token-speed.test.js): Added `--input-file` CLI argument
- [`README.md`](README.md): Added documentation for input file usage

## [1.0.2] - 2026-03-12

### Added
- **HTTP Client Module**: New `src/http-client.js` with unified HTTP request handling
  - HTTP Keep-Alive support using `agentkeepalive` for connection reuse
  - Automatic retry mechanism with exponential backoff
  - API rate limiting (429) handling with Retry-After header support
  - Parameter validation utilities

### Fixed
- **H1**: Improved async error handling in warmup phase (`src/concurrency.js`)
  - Added `Promise.allSettled` for graceful error handling
  - Implemented retry logic with rate limit detection
- **H2**: Added API rate limiting (429) handling
  - Automatic detection of 429 status code
  - Retry-After header parsing
  - Exponential backoff retry
- **H3**: Implemented request retry mechanism
  - Configurable max retries (default: 3)
  - Retryable status codes: 408, 429, 500, 502, 503, 504
  - Retryable errors: ECONNRESET, ENOTFOUND, ECONNABORTED, ETIMEDOUT
- **M4**: Enabled HTTP Keep-Alive for better connection efficiency
- **M5**: Added parameter validation with NaN detection
  - `safeParseInt` function with default value fallback
  - Warning messages for invalid parameters

### Changed
- [`src/concurrency.js`](src/concurrency.js): Refactored warmup phase with proper error handling
- [`src/token-speed.js`](src/token-speed.js): Added parameter validation
- [`src/index.js`](src/index.js): Added `safeParseInt` for safe integer parsing

### Security
- Added `agentkeepalive` dependency for connection pooling

## [1.0.1] - 2026-03-12

### Fixed
- **Token Speed Test**: Implemented true concurrency support using `Promise.all`
- **Concurrency Test**: Fixed potential division by zero error in error rate calculation
- **Token Counting**: Fixed inaccurate token counting using text estimation instead of chunk count
- **API Key Handling**: Only add Authorization header when apiKey is provided
- **RampUp Feature**: Implemented warmup phase with actual requests before main test
- **Config Loading**: Added `src/config.js` module to load and process config files with variable substitution
- **Code Quality**: Added radix parameter to all `parseInt()` calls

### Changed
- [`src/token-speed.js`](src/token-speed.js): Now properly executes concurrent tests when concurrency > 1
- [`src/concurrency.js`](src/concurrency.js): Added axios import and warmup phase implementation
- [`src/benchmark.js`](src/benchmark.js): Integrated config loader for centralized configuration
- All test files: Updated `parseInt()` calls with radix parameter

## [1.0.0] - 2026-03-12

### Added
- 🎉 Initial release
- 📊 Concurrency testing module for API endpoints
- ⚡ Token speed testing module for LLM APIs
- 📄 Multi-format report generation (JSON, Markdown, HTML)
- 🔧 CLI interface with multiple commands
- 📝 Comprehensive documentation for API performance testing standards
- 🏗️ Project structure with docs, src, tests, and config directories

### Features
- **Concurrency Testing**
  - Multiple concurrency levels support
  - Ramp-up time configuration
  - Real-time progress display
  - Detailed metrics: RPS, latency percentiles, error rates

- **Token Speed Testing**
  - Input/output token configuration
  - TTFT (Time To First Token) measurement
  - TPS (Tokens Per Second) calculation
  - Streaming and non-streaming support

- **Reporting**
  - JSON format for programmatic access
  - Markdown format for documentation
  - HTML format with visual metrics
  - Performance assessment and recommendations

### Documentation
- API performance testing standards in `docs/README.md`
- Core metrics definitions
- Testing types and methodologies
- Best practices and common pitfalls
- Tool recommendations