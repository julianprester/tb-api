# Contributing to Thunderbird API

Thank you for your interest in contributing to the Thunderbird API extension! This document provides guidelines and instructions for contributing.

## Getting Started

### Prerequisites

- Mozilla Thunderbird 115.0 or later
- Git
- A text editor or IDE

### Development Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/julianprester/tb-api.git
   cd tb-api
   ```

2. Load the extension in Thunderbird:
   - Open Thunderbird
   - Go to **Add-ons and Themes** (Tools menu or `Ctrl+Shift+A`)
   - Click the gear icon and select **Debug Add-ons**
   - Click **Load Temporary Add-on**
   - Select the `tb-api/manifest.json` file from the repository

3. The API will start automatically at `http://localhost:9595`

### Making Changes

- **Background script changes**: Reload the extension from the Debug Add-ons page
- **ES Module changes** (`.sys.mjs` files): Requires a full Thunderbird restart

## How to Contribute

### Reporting Bugs

Before submitting a bug report:

1. Check the [existing issues](https://github.com/julianprester/tb-api/issues) to avoid duplicates
2. Collect relevant information:
   - Thunderbird version
   - Operating system
   - Steps to reproduce
   - Expected vs actual behavior
   - Any error messages from the console

### Suggesting Features

Feature requests are welcome! Please:

1. Check existing issues for similar suggestions
2. Clearly describe the use case and expected behavior
3. Explain how it benefits AI/automation workflows

### Submitting Changes

1. Fork the repository
2. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. Make your changes
4. Test your changes using the test scripts:
   ```bash
   ./tests/test-api.sh
   ./tests/test-write-api.sh
   ```
5. Commit with a clear message:
   ```bash
   git commit -m "feat: add new endpoint for X"
   ```
6. Push to your fork and open a pull request

## Code Style

- Use ES6+ JavaScript features
- Use meaningful variable and function names
- Add comments for complex logic
- Follow existing patterns in the codebase
- Keep functions focused and modular

## Commit Message Format

We follow conventional commits:

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `chore:` - Maintenance tasks
- `refactor:` - Code refactoring
- `test:` - Test additions or changes

## Testing

Run the test scripts before submitting:

```bash
# Read-only endpoint tests
./tests/test-api.sh

# Write operation tests
./tests/test-write-api.sh

# Comprehensive edge case tests
./tests/test-comprehensive.sh
```

## Building

To build the extension package:

```bash
./build.sh
```

This creates `tb-api.xpi` which can be installed in Thunderbird.

## Questions?

Feel free to open an issue for questions or discussions about contributing.
