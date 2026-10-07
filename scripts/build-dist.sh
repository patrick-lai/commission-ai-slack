#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

fail() {
    printf 'build-dist: %s\n' "$1" >&2
    exit 1
}

command -v node >/dev/null 2>&1 || fail "node is required."

version=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' "$root/package.json")
case "$version" in
    ''|*[!0-9A-Za-z.+-]*) fail "could not read the version from package.json (got '$version')." ;;
esac
for file in package.json LICENSE bin/commission-ai-slack src/bin.js; do
    [ -f "$root/$file" ] || fail "missing $file."
done

dist="$root/dist"
tree="$dist/stage/commission-ai-slack"
rm -rf "$dist/stage"
mkdir -p "$tree/bin" "$tree/src"
cp "$root/bin/commission-ai-slack" "$tree/bin/commission-ai-slack"
cp "$root"/src/*.js "$tree/src/"
cp "$root/package.json" "$root/LICENSE" "$tree/"
find "$tree" -type d -exec chmod 0755 {} +
find "$tree" -type f -exec chmod 0644 {} +
chmod 0755 "$tree/bin/commission-ai-slack"

name="commission-ai-slack-$version.tar.gz"
scratch=$(mktemp -d "$dist/.pack.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
if [ "$(uname -s)" = Darwin ]; then
    COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf "$scratch/$name" -C "$dist/stage" commission-ai-slack
else
    tar -czf "$scratch/$name" -C "$dist/stage" commission-ai-slack
fi
if command -v sha256sum >/dev/null 2>&1; then
    sum=$(cd "$scratch" && sha256sum "$name")
else
    sum=$(cd "$scratch" && shasum -a 256 "$name")
fi
printf '%s\n' "$sum" > "$scratch/$name.sha256"
mv -f "$scratch/$name" "$dist/$name"
mv -f "$scratch/$name.sha256" "$dist/$name.sha256"
printf '%s\n' "$dist/$name"
