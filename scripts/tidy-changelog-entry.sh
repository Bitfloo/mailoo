#!/usr/bin/env bash
# cog writes the new CHANGELOG.md entry before the pre-bump hooks run. Its
# compare link starts at the first commit of the range, and it names an author
# once per commit, so link the entry from the previous tag and list each author once.
set -euo pipefail
latest=${1:?latest version}
version=${2:?version}
LATEST=$latest VERSION=$version perl -i -ne '
  BEGIN { $head = "## [v$ENV{VERSION}](" }
  if (index($_, $head) == 0) {
    $on = 1;
    s{/compare/[^)]*\.\.v\Q$ENV{VERSION}\E\)}{/compare/v$ENV{LATEST}..v$ENV{VERSION})};
  } elsif ($on && $_ eq "- - -\n") {
    $on = 0;
  } elsif ($on && /^(- .*\)\) - )(.+)$/) {
    my ($lead, %seen) = ($1);
    $_ = $lead . join(", ", grep { !$seen{$_}++ } split(/, /, $2)) . "\n";
  }
  print;
' CHANGELOG.md
