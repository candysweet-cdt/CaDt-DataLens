<?php
echo "hello from PHP\n";
echo "args: " . implode(' ', array_slice($argv, 1)) . "\n";
