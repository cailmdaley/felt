// fiber_lock holds the production fiber lock until its test releases stdin.
package main

import (
	"bufio"
	"fmt"
	"os"

	"github.com/cailmdaley/felt/internal/felt"
)

func main() {
	unlock, err := felt.LockFiberFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	defer unlock()
	fmt.Println("locked")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}
