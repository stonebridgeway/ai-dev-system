class AiDevSystem < Formula
  desc "Local-first MCP development system for AI agents"
  homepage "https://github.com/stonebridgeway/ai-dev-system"
  license "MIT"
  head "https://github.com/stonebridgeway/ai-dev-system.git", branch: "main"

  depends_on "git" => :build
  depends_on :macos

  def install
    libexec.install "ai-dev-mcp-server"
    libexec.install "docker"
    libexec.install "embeddings"
    libexec.install "frontend-qa"
    libexec.install "search-eval"
    libexec.install "search-index"
    libexec.install "bootstrap.sh"
    libexec.install "LICENSE"
    libexec.install "THIRD_PARTY_NOTICES.md"

    launcher = buildpath/"packaging/launcher.sh"
    inreplace launcher, "@AI_DEV_SYSTEM_ROOT@", libexec
    launcher.chmod 0755
    bin.install launcher => "ai-dev-system"
  end

  def caveats
    <<~EOS
      Finish the local setup with:
        ai-dev-system --install-prerequisites

      Docker Desktop may ask you to accept its license and approve the first-run
      privileged configuration before the Docker engine becomes ready.
    EOS
  end

  test do
    assert_equal libexec.to_s, shell_output("#{bin}/ai-dev-system root").strip
  end
end
