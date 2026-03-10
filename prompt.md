› # Overview

Each of the files in the `data` folder contains railroad measurement data. We installed 4 sensors in 4 different spots
on a railroad, waited for the train to pass, and measured.

Each file contains 2-dimensional data. The first column is the time (sec). The rest of the columns 4 sets of
measurements (because there are 4 sensors) per category such as stress, wheel load, lateral wheel load, and rail
displacement. You can ignore the trailing columns that do NOT have 4 sets of measurements.

Your task is to create a Python function, that takes the following as input:

1. Full path to the microsoft excel sheet containing the data.
2. X number wheels on the train.

And use math + polars/pandas/numpy (your pick) to find the measurement value for X peaks where X is the number
of wheels given. Sometimes the data is straightforward and X peaks are easy to pick out. Sometimes the data is murky
and the X peaks are not so easy to obtain, in which you must estimate and "do your best".

For example, given 40 wheels, I am expecting the following excel sheet file as output:

- The first row must be the headers (e.g, Wheel, Stress-1, Stress-2, Stress-3, Stress-4, Wheel Load 1 ...) that
  matches the columns of the input file MINUS the trailing columns that are ignored because there are no 4 sets.
- The first column is just a number from 1 to X.
- For the other columns, the rows should contain the measurement value of the X peaks.




